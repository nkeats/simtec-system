/* Stand-in for supabase-js, served in place of the CDN copy by the test harness.
   ⚠ TEST ONLY — never loaded by a real page.

   Every call is handed to window.__simdb, a function the Python harness exposes
   on the browser context. The database therefore lives in Python, OUTSIDE the
   page, so it survives a reload exactly as the real one does. That is the whole
   point: the faults this suite exists to catch happen across reloads.

   The builder mimics the parts of the PostgREST client the Sales App and auth.js
   actually use: from().select/insert/update/upsert/delete with eq/in/order/limit/
   single/maybeSingle, rpc(), storage.from().upload(), functions.invoke(), and a
   signed-in auth session. */
(function () {
  function call(req) {
    return window.__simdb(JSON.stringify(req)).then(function (raw) { return JSON.parse(raw); });
  }

  function builder(base) {
    var req = Object.assign({ filters: [], mods: {} }, base);
    var b = {
      select: function (cols) { if (!req.op) req.op = 'select'; req.mods.select = cols || '*'; return b; },
      insert: function (rows, opts) { req.op = 'insert'; req.payload = rows; req.opts = opts || {}; return b; },
      update: function (row, opts) { req.op = 'update'; req.payload = row; req.opts = opts || {}; return b; },
      upsert: function (rows, opts) { req.op = 'upsert'; req.payload = rows; req.opts = opts || {}; return b; },
      delete: function (opts) { req.op = 'delete'; req.opts = opts || {}; return b; },
      eq: function (c, v) { req.filters.push(['eq', c, v]); return b; },
      neq: function (c, v) { req.filters.push(['neq', c, v]); return b; },
      in: function (c, v) { req.filters.push(['in', c, v]); return b; },
      is: function (c, v) { req.filters.push(['is', c, v]); return b; },
      gte: function (c, v) { req.filters.push(['gte', c, v]); return b; },
      lte: function (c, v) { req.filters.push(['lte', c, v]); return b; },
      ilike: function (c, v) { req.filters.push(['ilike', c, v]); return b; },
      or: function () { return b; },
      order: function () { return b; },
      limit: function (n) { req.mods.limit = n; return b; },
      range: function () { return b; },
      single: function () { req.mods.single = true; return b; },
      maybeSingle: function () { req.mods.maybeSingle = true; return b; },
      then: function (res, rej) {
        if (!req.op) req.op = 'select';
        return call(req).then(res, rej);
      },
      catch: function (rej) { return b.then(undefined, rej); }
    };
    return b;
  }

  function createClient() {
    var session = {
      access_token: 'test-token',
      user: { id: '00000000-0000-4000-8000-00000000c0de', email: 'consultant@test.invalid' }
    };
    return {
      from: function (table) { return builder({ kind: 'table', table: table }); },
      rpc: function (fn, args) { return builder({ kind: 'rpc', fn: fn, args: args || {}, op: 'rpc' }); },
      auth: {
        getSession: function () { return Promise.resolve({ data: { session: session }, error: null }); },
        getUser: function () { return Promise.resolve({ data: { user: session.user }, error: null }); },
        signOut: function () { return Promise.resolve({ error: null }); },
        onAuthStateChange: function () { return { data: { subscription: { unsubscribe: function () {} } } }; }
      },
      storage: {
        from: function (bucket) {
          return {
            upload: function (path) { return call({ kind: 'storage', bucket: bucket, path: path, op: 'upload' }); },
            createSignedUrl: function () { return Promise.resolve({ data: { signedUrl: 'about:blank' }, error: null }); },
            getPublicUrl: function () { return { data: { publicUrl: 'about:blank' } }; }
          };
        }
      },
      functions: {
        invoke: function (name, opts) {
          /* The file body is dropped — only which function, and the non-bulky fields. */
          var body = Object.assign({}, (opts && opts.body) || {});
          if (body.data) body.data = '<' + String(body.data).length + ' chars>';
          return call({ kind: 'function', fn: name, body: body, op: 'invoke' });
        }
      },
      channel: function () { var c = { on: function () { return c; }, subscribe: function () { return c; } }; return c; },
      removeChannel: function () {}
    };
  }

  window.supabase = { createClient: createClient };
})();
