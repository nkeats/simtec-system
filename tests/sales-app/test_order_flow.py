"""Sales App regression suite — the order lifecycle and its ids.

Run:  python tests/sales-app/test_order_flow.py        (from the repo root)
      python tests/sales-app/test_order_flow.py -k park   (one group)

Each test is a fresh iPad: new browser, new storage, empty database.
It tests order-app.html AS IT IS IN THIS WORKING COPY — uncommitted edits included.

Why these tests exist: one pair of ids per sale is the duplicate-order guard
(10 Sep: the same $4,550 order written twice). The ids must stay put for the
whole of ONE sale — reloads, iOS discarding the page, the trip out to Ezidebit —
and must never be picked up by the NEXT sale (30 Sep: Daisy's sale written onto
Tino's ids from the day before). Both directions are tested here.
"""
import os
import re
import sys
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import App, Sale, start  # noqa: E402

FAILURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'failures')

UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
HOUR_MS = 60 * 60 * 1000

_pw = None


def setUpModule():
    global _pw
    _pw = start()


def tearDownModule():
    _pw.stop()


class SalesAppCase(unittest.TestCase):
    # Client errors a test deliberately provokes are listed here, by fragment.
    expected_client_errors = ()

    def setUp(self):
        self.app = App(_pw)
        self.app.context.set_default_timeout(15000)
        self.db = self.app.db
        self.app.open()

    def tearDown(self):
        try:
            if self._outcome_failed():
                os.makedirs(FAILURES, exist_ok=True)
                path = os.path.join(FAILURES, self._testMethodName + '.png')
                self.app.page.screenshot(path=path)
                print('\n  screenshot: %s   alerts: %r' % (path, self.app.alerts()))
        finally:
            self.app.close()

    def _outcome_failed(self):
        res = getattr(self._outcome, 'result', None)
        errs = (getattr(res, 'errors', []) or []) + (getattr(res, 'failures', []) or [])
        return any(t is self for t, _ in errs)

    # ---- shared checks ------------------------------------------------------
    def assertCleanRun(self):
        """No JavaScript error, and nothing reported to the office unless the test caused it."""
        self.assertEqual(self.app.page_errors, [], 'the page threw')
        unexpected = [e for e in self.db.client_errors
                      if not any(f in (e.get('p_action') or '') for f in self.expected_client_errors)]
        self.assertEqual(unexpected, [], 'the page reported faults to the office')

    def orders(self):
        return self.db.rows('sim_orders')

    def customers(self):
        return self.db.rows('sim_customers')

    def order(self, oid):
        found = [o for o in self.orders() if o['id'] == oid]
        self.assertEqual(len(found), 1, 'order %s should exist exactly once' % oid)
        return found[0]

    def customer(self, cid):
        found = [c for c in self.customers() if c['id'] == cid]
        self.assertEqual(len(found), 1, 'customer %s should exist exactly once' % cid)
        return found[0]

    def reenter(self, **kw):
        """After a reload the form is empty: the consultant keys the SAME sale in again."""
        return Sale(self.app, **kw).to_review().submit()


class FreshSale(SalesAppCase):
    def test_fresh_sale_mints_new_customer_and_order_ids(self):
        self.assertIsNone(self.app.stored_ids(), 'an empty app must hold no ids')
        Sale(self.app).to_review().submit()
        self.assertEqual(self.app.step(), 8)
        ids = self.app.stored_ids()
        self.assertRegex(ids['cust'], UUID)
        self.assertRegex(ids['order'], UUID)
        self.assertNotEqual(ids['cust'], ids['order'])
        self.assertFalse(ids.get('spent'), 'a draft save must NOT retire the ids')
        o = self.order(ids['order'])
        self.assertEqual(o['customer_id'], ids['cust'])
        self.assertEqual(o['confirmation_status'], 'draft')
        self.assertEqual(o['consultant_name'], 'Test Consultant')
        self.assertEqual(self.customer(ids['cust'])['first_name'], 'Aroha')
        self.assertEqual([i['product_name'] for i in self.db.rows('sim_order_items')],
                         ['Mk III Queen', 'Delivery fee'])
        # The harness itself: auth.js really ran against the stub.
        self.assertTrue(any(r.get('table') == 'profiles' for r in self.db.log),
                        'auth.js never asked the stub for the profile — the harness is not what the iPad runs')
        self.assertCleanRun()


class ReloadMidSale(SalesAppCase):
    expected_client_errors = ('save the order',)

    def test_reload_after_a_failed_save_keeps_ids_and_resubmit_writes_the_same_rows(self):
        # The customer and order rows land, the product lines are refused.
        self.db.fail_next_write('sim_order_items', 'simulated: items refused')
        Sale(self.app).to_review().submit()
        self.assertEqual(self.app.step(), 7, 'a failed save must stay on the review step')
        self.assertTrue(any('could not be saved' in a for a in self.app.alerts()),
                        'the consultant must be told the save failed')
        first = self.app.stored_ids()

        self.app.reload()
        self.assertEqual(self.app.stored_ids(), first, 'a reload must keep the ids')
        self.reenter()
        self.assertEqual(self.app.step(), 8)
        self.assertEqual(self.app.stored_ids()['order'], first['order'])
        self.assertEqual(len(self.orders()), 1, 'the resubmit created a second order')
        self.assertEqual(len(self.customers()), 1, 'the resubmit created a second customer')
        self.assertEqual(len(self.db.rows('sim_order_items')), 2, 'the lines must land exactly once')
        self.assertCleanRun()

    def test_reload_after_draft_save_before_ezidebit_keeps_ids_and_completes_the_same_order(self):
        """The window iOS discards the page in: saved as a draft, consultant not yet back from Ezidebit."""
        Sale(self.app).to_review().submit()
        draft = self.app.stored_ids()
        self.assertEqual(len(self.orders()), 1)

        self.app.reload()
        self.assertEqual(self.app.stored_ids(), draft, 'the draft\'s ids must survive the reload')
        self.assertFalse(self.app.stored_ids().get('spent'))

        s = self.reenter()
        self.assertEqual(self.app.stored_ids()['order'], draft['order'])
        s.ezidebit().finish()
        self.assertEqual(len(self.orders()), 1, 'finishing after the reload wrote a second order')
        o = self.order(draft['order'])
        self.assertEqual(o['confirmation_status'], 'pending')
        self.assertEqual(o['ezidebit_payer_ref'], '123456789')
        self.assertTrue(self.app.stored_ids()['spent'])
        self.assertCleanRun()


class EzidebitRoundTrip(SalesAppCase):
    def test_ezidebit_round_trip_returns_and_completes_the_same_order(self):
        s = Sale(self.app).to_review().submit()
        ids = self.app.stored_ids()
        s.ezidebit()
        self.assertEqual(self.app.ezi.opened[-1]['uRef'], ids['order'],
                         'Ezidebit must be given this order\'s id as the reference')
        self.assertEqual(self.app.stored_ids(), ids, 'the trip out to Ezidebit must not change the ids')
        self.assertEqual(self.order(ids['order'])['confirmation_status'], 'draft',
                         'the office must not see it until the consultant finishes')
        s.finish()
        o = self.order(ids['order'])
        self.assertEqual(len(self.orders()), 1)
        self.assertEqual(o['confirmation_status'], 'pending')
        self.assertEqual(o['ezidebit_payer_ref'], '123456789')
        self.assertEqual(o['payment_method'], 'weekly_dd')
        log = self.db.rows('ezidebit_callback_log')
        self.assertEqual([(r['order_id'], r['outcome']) for r in log], [(ids['order'], 'returned')])
        self.assertTrue(self.app.stored_ids()['spent'], 'Done must retire the ids')
        self.assertCleanRun()

    @unittest.expectedFailure
    def test_retrying_ezidebit_after_an_empty_return_caps_the_authority_at_the_order_balance(self):
        """⚠ KNOWN FAULT, found by this suite 30 Sep 2026 — remove the decorator when fixed.

        The page reloads on the way back from Ezidebit. The product lines are not
        restored, so eziTotal() is the delivery fee alone ($170). If Ezidebit comes
        back empty and the consultant opens the form again, the authority's total
        cap (tAmount) is built from that figure — a $4,910 sale capped at $170.
        When this starts passing, unittest reports it as an UNEXPECTED SUCCESS."""
        self.app.ezi.come_back_empty = True
        s = Sale(self.app).to_review().submit()
        p = self.app.page
        first_cap = None
        p.fill('#eziPlanAmount', '25')
        with p.expect_navigation(url=re.compile(r'order-app\.html')):
            p.click('button:has-text("Open secure Ezidebit form")')
        self.app.wait_ready()
        p.wait_for_function('() => S.step === 8')
        first_cap = self.app.ezi.opened[-1].get('tAmount')
        self.assertEqual(first_cap, '4910.00', 'the first launch should cap at the full balance')
        self.assertIn('did not send the direct debit details back', p.inner_text('#eziMsg'))

        self.app.ezi.come_back_empty = False
        with p.expect_navigation(url=re.compile(r'order-app\.html')):
            p.click('button:has-text("Open secure Ezidebit form")')
        self.app.wait_ready()
        self.assertEqual(self.app.ezi.opened[-1].get('tAmount'), '4910.00',
                         'the retry built the direct-debit authority from a different total')


class IdsNeverReused(SalesAppCase):
    def _second_sale(self):
        Sale(self.app, first='Mere', last='Secondsale', mobile='021 555 0202',
             email='mere@test.invalid').to_review().submit()
        return self.app.stored_ids()

    def _assert_two_separate_sales(self, first, second):
        self.assertNotEqual(first['cust'], second['cust'])
        self.assertNotEqual(first['order'], second['order'])
        self.assertEqual(len(self.orders()), 2)
        self.assertEqual(self.order(first['order'])['customer_id'], first['cust'])
        self.assertEqual(self.order(second['order'])['customer_id'], second['cust'])
        self.assertEqual(self.customer(first['cust'])['first_name'], 'Aroha', 'sale 2 touched sale 1\'s customer')
        self.assertEqual(self.customer(second['cust'])['first_name'], 'Mere')

    def test_finished_sale_then_start_new_order_mints_new_ids(self):
        Sale(self.app).whole()
        first = self.app.stored_ids()
        with self.app.page.expect_navigation():
            self.app.page.click('button:has-text("Start new order")')
        self.app.wait_ready()
        self.assertIsNone(self.app.stored_ids(), 'Start new order must clear the ids')
        self._assert_two_separate_sales(first, self._second_sale())
        self.assertCleanRun()

    def test_finished_sale_then_app_reopened_next_morning_mints_new_ids(self):
        """The Home-Screen app: nobody taps Start new order, iOS just restores the tab."""
        Sale(self.app).whole()
        first = self.app.stored_ids()
        self.app.reload()
        self.assertIsNone(self.app.stored_ids(), 'spent ids must be dropped at start-up')
        self._assert_two_separate_sales(first, self._second_sale())
        self.assertCleanRun()

    def test_ids_older_than_8_hours_are_never_reused(self):
        """Daisy's case: a sale that never reached Done, its ids still there 27 hours later."""
        Sale(self.app).to_review().submit()
        first = self.app.stored_ids()
        self.assertFalse(first.get('spent'))
        aged = dict(first, at=int(time.time() * 1000) - 8 * HOUR_MS - 60 * 1000)
        self.app.set_stored_ids(aged)
        self.app.reload()
        self.assertIsNone(self.app.stored_ids(), 'ids older than 8 hours must be dropped at start-up')
        self._assert_two_separate_sales(first, self._second_sale())
        self.assertCleanRun()

    def test_ids_just_under_8_hours_are_still_this_sale(self):
        """The other side of the line: a long sale keeps its ids, or a reload duplicates it."""
        Sale(self.app).to_review().submit()
        first = self.app.stored_ids()
        self.app.set_stored_ids(dict(first, at=int(time.time() * 1000) - 8 * HOUR_MS + 5 * 60 * 1000))
        self.app.reload()
        self.assertEqual(self.app.stored_ids()['order'], first['order'])
        self.reenter()
        self.assertEqual(len(self.orders()), 1)
        self.assertCleanRun()

    def test_ids_with_no_mint_time_are_never_reused(self):
        """Ids written by a build before the 30 Sep fix carry no time at all."""
        Sale(self.app).to_review().submit()
        first = self.app.stored_ids()
        self.app.set_stored_ids({'cust': first['cust'], 'order': first['order']})
        self.app.reload()
        self.assertIsNone(self.app.stored_ids())
        self._assert_two_separate_sales(first, self._second_sale())
        self.assertCleanRun()


class ParkedOrders(SalesAppCase):
    expected_client_errors = ('save the order', 'upload a parked order',
                              'load the consultant list', 'load the live price list')

    def test_parked_order_replays_under_its_own_ids_not_the_devices(self):
        # Sale A: the save fails on the network → parked, carrying A's ids.
        self.db.down = True
        Sale(self.app).to_review().submit()
        self.assertEqual(self.app.step(), 9)
        parked = self.app.parked()
        self.assertEqual(len(parked), 1, 'the failed save must park the order')
        a_ids = parked[0]['ids']
        self.assertEqual(self.orders(), [])

        # Sale B on the same iPad, connection back, gets its own ids.
        self.db.down = False
        with self.app.page.expect_navigation():
            self.app.page.click('button:has-text("Start new order")')
        self.app.wait_ready()
        # The reload's start-up sync uploads A. (The replay WHILE the device holds
        # another sale's ids is the next test.)
        self.app.page.wait_for_function("() => !syncing && JSON.parse(localStorage.getItem('simtec_parked_orders')||'[]').length === 0")
        self.assertEqual(len(self.app.parked()), 0, 'boot sync should have uploaded the parked order')
        self.assertEqual(self.order(a_ids['order'])['customer_id'], a_ids['cust'])

        Sale(self.app, first='Mere', last='Secondsale', mobile='021 555 0202',
             email='mere@test.invalid').to_review().submit()
        b_ids = self.app.stored_ids()
        self.assertNotEqual(a_ids['order'], b_ids['order'])
        self.assertNotEqual(a_ids['cust'], b_ids['cust'])
        self.assertEqual(len(self.orders()), 2)
        self.assertEqual(self.customer(a_ids['cust'])['first_name'], 'Aroha')
        self.assertEqual(self.customer(b_ids['cust'])['first_name'], 'Mere')
        self.assertCleanRun()

    def test_parked_order_replayed_while_device_holds_another_sales_ids(self):
        # Park A while the upload keeps failing — through Start new order and the
        # start-up sync too, so A is still on the iPad when sale B begins.
        self.db.down = True
        Sale(self.app).to_review().submit()
        a_ids = self.app.parked()[0]['ids']
        with self.app.page.expect_navigation():
            self.app.page.click('button:has-text("Start new order")')
        self.app.wait_ready()
        self.assertEqual(len(self.app.parked()), 1, 'A should still be parked')
        self.db.down = False
        Sale(self.app, first='Mere', last='Secondsale', mobile='021 555 0202',
             email='mere@test.invalid').to_review().submit()
        b_ids = self.app.stored_ids()
        self.assertEqual(len(self.app.parked()), 1, 'A should still be parked')

        # Coverage returns: the real 'online' handler replays A.
        self.app.page.evaluate("window.dispatchEvent(new Event('online'))")
        self.app.page.wait_for_function("() => !syncing && JSON.parse(localStorage.getItem('simtec_parked_orders')||'[]').length === 0")
        self.assertEqual(self.order(a_ids['order'])['customer_id'], a_ids['cust'], 'A replayed under the wrong ids')
        self.assertEqual(self.customer(a_ids['cust'])['first_name'], 'Aroha')
        self.assertEqual(self.app.stored_ids(), b_ids, 'replaying A must not disturb B\'s ids')
        self.assertEqual(self.app.page.evaluate('S.orderIds.order'), b_ids['order'])
        self.assertEqual(len(self.orders()), 2)
        items_a = [i for i in self.db.rows('sim_order_items') if i['order_id'] == a_ids['order']]
        self.assertEqual(len(items_a), 2)
        self.assertCleanRun()

    def test_order_parked_offline_uploads_when_back_online(self):
        self.app.context.set_offline(True)
        Sale(self.app).to_review().submit()
        self.assertEqual(self.app.step(), 9)
        self.assertIn('parked', self.app.page.inner_text('#doneTitle').lower())
        ids = self.app.parked()[0]['ids']
        self.assertEqual(self.orders(), [], 'nothing should reach the database while offline')

        self.app.context.set_offline(False)
        self.app.page.wait_for_function("() => !syncing && JSON.parse(localStorage.getItem('simtec_parked_orders')||'[]').length === 0")
        o = self.order(ids['order'])
        self.assertEqual(o['customer_id'], ids['cust'])
        self.assertEqual(len(self.db.rows('sim_order_items')), 2)
        self.assertIn('uploaded', self.app.page.inner_text('#doneMsg'))
        self.assertCleanRun()

    @unittest.expectedFailure
    def test_offline_start_new_order_keeps_the_signed_in_consultant(self):
        """⚠ KNOWN FAULT, found by this suite 30 Sep 2026 — remove the decorator when fixed.

        Offline, Start new order resets the form in place (resetForm) instead of
        reloading. That resets EVERY <select>, including the consultant one that
        lockConsultantToLogin() filled and hid. The consultant's name still shows
        on screen, but Next refuses with "Enter consultant, date and sale type" and
        the dropdown is hidden, so they cannot take a second sale until they are
        back online."""
        self.app.context.set_offline(True)
        Sale(self.app).to_review().submit()
        self.assertEqual(self.app.step(), 9)
        self.app.page.click('button:has-text("Start new order")')
        self.app.page.wait_for_function('() => S.step === 0')
        self.assertEqual(self.app.page.evaluate("val('consultant')"), 'Test Consultant')
        Sale(self.app, first='Mere', last='Secondsale', mobile='021 555 0202',
             email='mere@test.invalid').to_review()


if __name__ == '__main__':
    argv = sys.argv[:]
    unittest.main(argv=argv, verbosity=2)
