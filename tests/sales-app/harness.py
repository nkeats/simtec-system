"""Harness for the Sales App regression suite.

Loads the REAL order-app.html from this repository in headless Chromium, on a
fake https origin, with supabase-js swapped for stub_supabase.js. The stub hands
every database call to FakeDB, below, which lives in Python — outside the page —
so it survives a reload exactly as the real database does.

What is real: order-app.html, auth.js, update.js, ezidebit-return.html, the
browser, sessionStorage/localStorage, reloads, the online/offline events.
What is fake: the database (FakeDB), and Ezidebit's hosted form (a page that
sends the browser straight back to the callback with a result).

FakeDB copies the two behaviours the order lifecycle depends on:
  * upsert with ignoreDuplicates is ON CONFLICT DO NOTHING;
  * tg_id_belongs_to_one_sale — a BEFORE trigger, so it fires before the
    conflict check — refuses a customer id that already holds a different
    person, and an order id that already belongs to a different customer.
    The messages are copied from the live function (checked 30 Sep 2026).
"""
import json
import mimetypes
import os
import re
import time
import urllib.parse

from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
# The pages are served from this repository — or, with SALES_APP_ROOT, from any
# other folder holding them (a checkout of what is live, or a deliberately broken
# copy used to prove the suite catches the fault).
REPO = os.path.abspath(os.environ.get('SALES_APP_ROOT') or os.path.join(HERE, '..', '..'))
ORIGIN = 'https://app.simtec.test'
STUB_JS = open(os.path.join(HERE, 'stub_supabase.js'), encoding='utf-8').read()
SUPABASE_JS = re.compile(r'^https://cdn\.jsdelivr\.net/npm/@supabase/supabase-js')

CONSULTANT = 'Test Consultant'

TRIGGER_CUSTOMER = ('This device is trying to save a new customer onto an existing customer record, '
                    'so nothing has been saved. Start a new order on this device and enter the sale again.')
TRIGGER_ORDER = ('This device is trying to save a new order onto an existing order for a different '
                 'customer, so nothing has been saved. Start a new order on this device and enter the sale again.')

KEYS = {'sim_customers': ('id',), 'sim_orders': ('id',), 'sim_order_items': ('order_id', 'line_no')}


def _norm_name(r):
    return ' '.join(((r.get('first_name') or '') + ' ' + (r.get('last_name') or '')).split()).lower()


class FakeDB:
    def __init__(self):
        self.tables = {}
        self.log = []            # every request, in order
        self.client_errors = []  # report_client_error calls
        self.down = False        # True → every call fails the way a dropped connection does
        self._fail_once = {}     # table → error message for the next write to it

    def fail_next_write(self, table, message='simulated server error'):
        self._fail_once[table] = message

    # ---- helpers for tests -------------------------------------------------
    def rows(self, table):
        return self.tables.setdefault(table, [])

    def seed(self, table, row):
        self.rows(table).append(dict(row))

    def writes(self, table=None):
        return [r for r in self.log if r.get('op') in ('insert', 'upsert', 'update', 'delete')
                and (table is None or r.get('table') == table)]

    # ---- the stub's entry point --------------------------------------------
    def handle(self, raw):
        req = json.loads(raw)
        self.log.append(req)
        if self.down:
            return json.dumps({'data': None, 'error': {'message': 'TypeError: Failed to fetch'}})
        if req.get('op') in ('insert', 'upsert', 'update') and req.get('table') in self._fail_once:
            return json.dumps({'data': None, 'error': {'message': self._fail_once.pop(req['table'])}})
        try:
            data, error = self._dispatch(req)
        except Exception as e:  # a harness fault must be loud, never a fake database error
            raise RuntimeError('FakeDB could not handle %r: %s' % (req, e))
        return json.dumps({'data': data, 'error': error})

    def _dispatch(self, req):
        kind = req['kind']
        if kind == 'rpc':
            return self._rpc(req['fn'], req.get('args') or {})
        if kind == 'storage':
            return {'path': req['path']}, None
        if kind == 'function':
            if req['fn'] == 'upload-order-document':
                return {'ok': True}, None
            return {'status': 'disabled'}, None
        return self._table(req)

    def _rpc(self, fn, args):
        if fn == 'list_active_consultants':
            return [{'name': CONSULTANT, 'team_leader': 'Test Leader'}], None
        if fn == 'sales_catalogue':
            return [{'key': 'mk3_queen', 'name': 'Mk III Queen', 'retail': 4740},
                    {'key': 'pillow', 'name': 'Pillow', 'retail': 160},
                    {'key': 'delivery', 'name': 'Delivery', 'retail': 170}], None
        if fn == 'report_client_error':
            self.client_errors.append(args)
            return None, None
        return None, None

    def _match(self, row, filters):
        for op, col, val in filters:
            if op == 'eq' and row.get(col) != val:
                return False
            if op == 'in' and row.get(col) not in val:
                return False
        return True

    def _trigger(self, table, new):
        """tg_id_belongs_to_one_sale — fires BEFORE the conflict check."""
        if table == 'sim_customers':
            ex = next((r for r in self.rows(table) if r['id'] == new.get('id')), None)
            if ex and ((ex.get('mobile') or '') != (new.get('mobile') or '')
                       or _norm_name(ex) != _norm_name(new)):
                return {'message': TRIGGER_CUSTOMER, 'code': '23514'}
        if table == 'sim_orders':
            ex = next((r for r in self.rows(table) if r['id'] == new.get('id')), None)
            if ex and ex.get('customer_id') != new.get('customer_id'):
                return {'message': TRIGGER_ORDER, 'code': '23514'}
        return None

    def _table(self, req):
        table, op = req['table'], req['op']
        rows = self.rows(table)
        if op == 'select':
            if table == 'profiles':
                prof = {'role': 'consultant', 'active': True, 'consultant_name': CONSULTANT,
                        'full_name': CONSULTANT, 'email': 'consultant@test.invalid'}
                return (prof if req['mods'].get('single') or req['mods'].get('maybeSingle') else [prof]), None
            found = [r for r in rows if self._match(r, req['filters'])]
            if req['mods'].get('single') or req['mods'].get('maybeSingle'):
                return (found[0] if found else None), None
            return found, None

        if op in ('insert', 'upsert'):
            payload = req['payload']
            batch = payload if isinstance(payload, list) else [payload]
            key = KEYS.get(table)
            ignore = bool((req.get('opts') or {}).get('ignoreDuplicates'))
            for new in batch:  # the whole statement fails if any row is refused
                err = self._trigger(table, new)
                if err:
                    return None, err
            for new in batch:
                ex = None
                if key:
                    ex = next((r for r in rows if all(r.get(k) == new.get(k) for k in key)), None)
                if ex is not None:
                    if op == 'insert':
                        return None, {'message': 'duplicate key value violates unique constraint', 'code': '23505'}
                    if ignore:
                        continue
                    ex.update(new)
                else:
                    rows.append(dict(new))
            return None, None

        if op == 'update':
            for r in rows:
                if self._match(r, req['filters']):
                    r.update(req['payload'])
            return None, None

        if op == 'delete':
            self.tables[table] = [r for r in rows if not self._match(r, req['filters'])]
            return None, None
        raise ValueError('unknown op ' + op)


class EziForm:
    """Stands in for Ezidebit's hosted form: records the URL it was opened with
    and sends the browser straight to the callback, as a completed form does."""

    def __init__(self):
        self.opened = []
        self.result = {'cref': '123456789', 'ramount': '25.00', 'freq': '1', 'numpayments': '190'}
        self.come_back_empty = False   # True → back to the callback with nothing, as has happened live

    def page_for(self, url):
        q = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(url).query))
        self.opened.append(q)
        if self.come_back_empty:
            return '<!doctype html><script>location.replace(%s)</script>' % json.dumps(q['callback'])
        params = dict(self.result)
        params['uref'] = q.get('uRef', '')
        params.setdefault('rdate', q.get('rDate', ''))
        back = q['callback'] + ('&' if '?' in q['callback'] else '?') + urllib.parse.urlencode(params)
        return '<!doctype html><title>Ezidebit (test)</title><script>location.replace(%s)</script>' % json.dumps(back)


class App:
    """One consultant iPad: one browser context, one tab, one FakeDB behind it."""

    def __init__(self, pw, db=None):
        self.db = db or FakeDB()
        self.ezi = EziForm()
        self.dialogs = []
        self.page_errors = []
        self.browser = pw.chromium.launch()
        # An iPad in portrait, with Safari's user agent. The agent is set on the
        # CONTEXT so every request and navigator.userAgent agree.
        self.context = self.browser.new_context(
            viewport={'width': 820, 'height': 1180}, device_scale_factor=1,
            user_agent=('Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 '
                        '(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'))
        self.context.expose_function('__simdb', self.db.handle)
        self.context.route('**/*', self._route)
        self.page = self.context.new_page()
        self.page.on('dialog', self._dialog)
        self.page.on('pageerror', lambda e: self.page_errors.append(str(e)))

    def close(self):
        try:
            self.browser.close()
        except Exception:
            pass

    # ---- network ---------------------------------------------------------
    def _route(self, route):
        url = route.request.url
        if url.startswith(ORIGIN + '/'):
            path = urllib.parse.urlsplit(url).path.lstrip('/') or 'index.html'
            full = os.path.normpath(os.path.join(REPO, path))
            if not full.startswith(REPO) or not os.path.isfile(full):
                return route.fulfill(status=404, body='not found')
            ctype = mimetypes.guess_type(full)[0] or 'application/octet-stream'
            with open(full, 'rb') as f:
                return route.fulfill(status=200, body=f.read(), headers={'content-type': ctype})
        if SUPABASE_JS.match(url):
            return route.fulfill(status=200, body=STUB_JS, headers={'content-type': 'application/javascript'})
        host = urllib.parse.urlsplit(url).hostname or ''
        if host.endswith('ezidebit.com.au'):
            return route.fulfill(status=200, body=self.ezi.page_for(url),
                                 headers={'content-type': 'text/html'})
        if host.endswith('supabase.co'):   # raw fetch() calls, e.g. the rewards-app link
            return route.fulfill(status=200, body='{}', headers={'content-type': 'application/json'})
        if host in ('cdn.jsdelivr.net', 'cdnjs.cloudflare.com'):
            return route.continue_()       # jsPDF and the QR library, the real ones
        return route.abort()               # nothing else leaves the test

    def _dialog(self, d):
        self.dialogs.append((d.type, d.message))
        if d.type == 'confirm' and 'Email not verified' in d.message:
            d.accept()
        else:
            d.dismiss() if d.type == 'confirm' else d.accept()

    def alerts(self):
        return [m for t, m in self.dialogs if t == 'alert']

    # ---- page lifecycle ----------------------------------------------------
    def open(self, query=''):
        self.page.goto(ORIGIN + '/order-app.html' + query)
        self.wait_ready()

    def reload(self):
        """What iOS does when it discards the page under memory pressure: the same
        tab, so sessionStorage and localStorage both survive."""
        self.page.reload()
        self.wait_ready()

    def wait_ready(self):
        self.page.wait_for_function('() => window.SIMTEC_USER && document.getElementById("consultantFixed")')
        self.page.wait_for_function('() => document.querySelector("section.step.on")')

    def step(self):
        return self.page.evaluate('() => S.step')

    def stored_ids(self):
        return self.page.evaluate("() => JSON.parse(sessionStorage.getItem('simtec_order_ids_v1') || 'null')")

    def set_stored_ids(self, ids):
        self.page.evaluate("v => sessionStorage.setItem('simtec_order_ids_v1', JSON.stringify(v))", ids)

    def parked(self):
        return self.page.evaluate("() => JSON.parse(localStorage.getItem('simtec_parked_orders') || '[]')")

    def next(self):
        self.page.click('#nextBtn')
        self.page.wait_for_function('() => !stepBusy')

    def sign(self, canvas_id):
        box = self.page.locator('#' + canvas_id)
        # Centre it, as a consultant scrolls it clear of the fixed Back/Next bar.
        # Playwright's own "in view" counts a box hidden UNDER that bar as visible.
        box.evaluate("el => el.scrollIntoView({block: 'center'})")
        b = box.bounding_box()
        # ⚠ The stroke must land ON the canvas. If something covers it, a real
        # consultant could not sign it either — fail here, not three steps later.
        hit = self.page.evaluate('([x, y]) => (document.elementFromPoint(x, y) || {}).id || null',
                                 [b['x'] + b['width'] / 2, b['y'] + b['height'] / 2])
        assert hit == canvas_id, 'signature box %s is covered by %r' % (canvas_id, hit)
        m = self.page.mouse
        m.move(b['x'] + 10, b['y'] + b['height'] / 2)
        m.down()
        for i in range(1, 8):
            m.move(b['x'] + 10 + i * (b['width'] - 20) / 7, b['y'] + b['height'] / 2 + (8 if i % 2 else -8))
        m.up()


class Sale:
    """Drives one sale through the real UI, a step at a time, as a consultant would."""

    def __init__(self, app, first='Aroha', last='Testcustomer', mobile='021 555 0101',
                 email='aroha@test.invalid', pay='ezidebit'):
        self.app, self.first, self.last, self.mobile, self.email, self.pay = app, first, last, mobile, email, pay

    def to_review(self):
        """Steps 0-6, ending on step 7 (Sign) with the applicant's signature drawn."""
        a, p = self.app, self.app.page
        assert a.step() == 0, 'expected the start step, on %s' % a.step()
        p.click('#saleType .choice[data-val="unsolicited"]')
        a.next()
        assert a.step() == 1, self._stuck(1)
        p.locator('#prodBody select').first.select_option(index=1)
        a.next()
        assert a.step() == 2, self._stuck(2)
        p.fill('#a1first', self.first)
        p.fill('#a1last', self.last)
        p.fill('#mobile', self.mobile)
        p.fill('#email', self.email)
        p.fill('#street', '1 Test Street')
        a.next()
        assert a.step() == 3, self._stuck(3)
        a.next()
        assert a.step() == 4, self._stuck(4)
        p.evaluate("() => { const b=document.getElementById('tncBox'); b.scrollTop=b.scrollHeight; tncScrolled(b); }")
        p.check('#tncAgree')
        for box in p.locator('.ackrow:not(.hidden) .ackbox').all():
            box.check()
        for c in ['iTnc', 'iAck1', 'iAck2', 'iAck3', 'iAck4']:
            a.sign(c)
        a.next()
        assert a.step() == 5, self._stuck(5)
        p.click('#noIdBtnA1')
        p.click('#noIdChoicesA1 .choice[data-val="Customer has no photo ID"]')
        a.next()
        assert a.step() == 6, self._stuck(6)
        p.click('#payOption .choice[data-val="%s"]' % self.pay)
        a.next()
        assert a.step() == 7, self._stuck(7)
        a.sign('sigA1')
        return self

    def submit(self):
        """Step 7 → the draft save. Lands on step 8 (Ezidebit), or 9 if parked."""
        self.app.next()
        return self

    def ezidebit(self):
        """Step 8: fill the plan, go out to the Ezidebit form and come back."""
        a, p = self.app, self.app.page
        assert a.step() == 8, self._stuck(8)
        p.fill('#eziPlanAmount', '25')
        with p.expect_navigation(url=re.compile(r'order-app\.html'), timeout=15000):
            p.click('button:has-text("Open secure Ezidebit form")')
        a.wait_ready()
        p.wait_for_function('() => S.step === 8 && S.eziRef')
        return self

    def finish(self):
        """Sign the direct-debit authority and tap Finish → Done."""
        a = self.app
        a.sign('sigEzi')
        a.next()
        assert a.step() == 9, self._stuck(9)
        a.page.wait_for_function('() => S.finalized')
        try:
            a.page.wait_for_function(
                "() => (JSON.parse(sessionStorage.getItem('simtec_order_ids_v1')||'{}')).spent === true", timeout=5000)
        except Exception:
            raise AssertionError('the sale reached Done but its ids were not retired (spent) — '
                                 'the next sale on this iPad could be written onto this one')
        return self

    def whole(self):
        return self.to_review().submit().ezidebit().finish()

    def _stuck(self, want):
        return 'sale did not reach step %s (on %s). Alerts: %r' % (want, self.app.step(), self.app.alerts()[-3:])


def start():
    return sync_playwright().start()
