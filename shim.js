/* ============================================================================
   MISMO MONEY ON resources.mismo.org — the door to MISMO's save relay
   ----------------------------------------------------------------------------
   MISMO Money was built inside Claude, where every screen reaches its records
   through window.claude.use('db' | 'user' | 'downloads' | 'assets' | 'sample').
   This file gives the page that same door, backed by the save relay, so none
   of the screens had to change how they read or save.

   NOTHING CONFIDENTIAL IS IN THIS REPOSITORY. Not the records and not the page
   code either: MISMO Money's rules and checks are written around MISMO's real
   figures, so the whole application lives in the PRIVATE repository
   GitMISMO/financials-data (folder app/) and arrives only after sign-in, through
   the relay, under the project key below. This file and index.html are the
   only things served publicly.

   How records are filed in financials-data/data/ (the relay reads and writes
   files of at most 1 MB and has no "list a folder" route):
     index.json            which file holds each record, and a version for each
                           file, so a reader can tell what changed
     c-<collection>-<n>    the records of one collection, packed into files of
                           at most 900 KB each ({docs:{"<collection>/<id>":{...}}})
   Every save is ONE commit holding the changed files and the new index, so a
   reader never sees a record in two places or in none. A save carries the
   commit it was built on; if anyone saved in between, the relay answers 409 and
   the change is re-applied on top of theirs and sent again.

   Kept files (invoices, statements) go to files/<id> in the same repository.
   Ask AI on the Help page goes to the relay's Ask route if it is switched on
   for this project; otherwise the box stays hidden, as it always has when the
   page cannot ask.
   ========================================================================== */
(function () {
  'use strict';
  if (window.__mmRelay) return;

  var CFG = window.MM_CONFIG || {};
  var RELAY_URL = CFG.relay || 'https://rgvdi67cg27o5kcmiytcqbqnrm0hmztx.lambda-url.us-east-1.on.aws';
  var PROJECT = CFG.project || 'financials';
  var TOOL = 'MISMO Money';
  var POLL_MS = 30000, IDLE_POLL_MS = 120000, IDLE_AFTER = 10 * 60000;
  var FLUSH_MS = 350, RETRY_MS = 8000;
  var MAX_FILE = 900000;          /* bytes per data file; the relay reads at most 1 MB */
  var MAX_COMMIT = 5200000;       /* bytes per commit request; the relay takes 5.5 MB */
  var READS_AT_ONCE = 8;          /* the records are about twenty files: two rounds, not five */

  /* ---------- browser storage: every tool shares this web address ---------- */
  (function () {
    var P = 'tools:' + PROJECT + ':';
    var shared = function (k) { k = String(k); return k.indexOf('tools:') === 0 || k.indexOf('resources:') === 0 || k === 'mismo.portal.theme'; };
    try {
      var S = Storage.prototype, g = S.getItem, s = S.setItem, r = S.removeItem;
      S.getItem = function (k) { return g.call(this, shared(k) ? k : P + k); };
      S.setItem = function (k, v) { return s.call(this, shared(k) ? k : P + k, v); };
      S.removeItem = function (k) { return r.call(this, shared(k) ? k : P + k); };
      S.clear = function () { throw new Error('localStorage.clear() would wipe every tool on this site'); };
    } catch (e) {}
  })();

  function RS() { return window.ResourcesSession || null; }
  function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
  function err(code, message, status) { var e = new Error(message || code); e.code = code; e.status = status || 0; return e; }
  function now() { return Date.now(); }
  var enc = new TextEncoder();
  function bytesOf(s) { return enc.encode(s).length; }
  /* the relay's file names: lowercase letters, digits and hyphens, at most 40 */
  function hash8(s) { var h = 5381; s = String(s); for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return ('0000000' + h.toString(36)).slice(-8); }
  function safe(s) { return String(s).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '') || 'x'; }
  function fname(s) { s = safe(s); return s.length <= 40 ? s : s.slice(0, 31).replace(/-+$/, '') + '-' + hash8(s); }
  function fileFor(coll, n) { return fname('c-' + safe(coll).slice(0, 24) + '-' + hash8(coll).slice(0, 4) + '-' + n); }
  function parentOf(path) { var s = String(path).split('/'); return s.slice(0, -1).join('/'); }
  function idOf(path) { var s = String(path).split('/'); return s[s.length - 1]; }
  function checkPath(path) {
    var seg = String(path).split('/');
    if (seg.length < 2 || seg.length % 2 || seg.some(function (x) { return !x; })) throw err('invalid_argument', 'Not a document path: ' + path);
  }

  /* ---------- talking to the relay ---------- */
  var status = { offline: false, lastError: '' };
  function net(method, route, body) {
    var rs = RS(), tok = rs && rs.token();
    if (!tok) return Promise.reject(err('SIGNED_OUT', 'Not signed in', 401));
    var headers = { 'Authorization': 'Bearer ' + tok };
    if (body) headers['Content-Type'] = 'application/json';
    return fetch(RELAY_URL + '/' + PROJECT + '/' + route, {
      method: method, cache: 'no-store', headers: headers, body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      status.offline = false;
      return r.json().catch(function () { return {}; }).then(function (b) {
        if (r.ok) return b;
        var e = err((b && b.error) || ('HTTP_' + r.status), b && b.message, r.status);
        e.body = b || {};
        e.gh = (b && typeof b.status === 'number') ? b.status : 0;
        if (r.status === 401 && rs) needSignIn();
        throw e;
      });
    }, function () { status.offline = true; throw err('OFFLINE', 'Could not reach the relay', 0); });
  }
  function readData(name) {
    return net('GET', 'data/' + encodeURIComponent(name)).then(function (b) { return (b && b.data) || null; });
  }
  /* a few at a time (each is one GitHub request, so this changes how fast, not how many) */
  function readMany(names) {
    var out = {}, i = 0;
    function next() {
      if (i >= names.length) return Promise.resolve();
      var n = names[i++];
      return readData(n).then(function (d) { out[n] = d; }).then(next);
    }
    var lanes = []; for (var k = 0; k < READS_AT_ONCE; k++) lanes.push(next());
    return Promise.all(lanes).then(function () { return out; });
  }

  /* ---------- what is on the server, as last read ---------- */
  var IDX = null;            /* {rev, files:{name:{rev,bytes,coll}}, docs:{path:name}} */
  var FILES = {};            /* name -> {docs:{path:body}} */
  var HEAD = null;           /* the commit IDX and FILES were read at, once known */
  function emptyIndex() { return { rev: 0, files: {}, docs: {} }; }
  function normIndex(d) {
    d = d && typeof d === 'object' ? d : {};
    return { rev: Number(d.rev) || 0, files: d.files && typeof d.files === 'object' ? d.files : {}, docs: d.docs && typeof d.docs === 'object' ? d.docs : {} };
  }
  function normFile(d) { return { docs: d && d.docs && typeof d.docs === 'object' ? d.docs : {} }; }
  function loadAll() {
    return readData('index').then(function (d) {
      var idx = normIndex(d);
      return readMany(Object.keys(idx.files)).then(function (got) {
        var files = {};
        Object.keys(idx.files).forEach(function (n) { files[n] = normFile(got[n]); });
        IDX = idx; FILES = files; rebuild();
      });
    });
  }
  /* pick up what others saved: the index first, then only the files whose version moved */
  function refresh() {
    return readData('index').then(function (d) {
      var idx = normIndex(d);
      if (IDX && idx.rev === IDX.rev) return false;
      var moved = Object.keys(idx.files).filter(function (n) {
        return !IDX || !IDX.files[n] || IDX.files[n].rev !== idx.files[n].rev || !FILES[n];
      });
      return readMany(moved).then(function (got) {
        var files = {};
        Object.keys(idx.files).forEach(function (n) { files[n] = moved.indexOf(n) >= 0 ? normFile(got[n]) : FILES[n]; });
        IDX = idx; FILES = files; HEAD = null;
        rebuild();
        return true;
      });
    });
  }

  /* ---------- the view: the server's records with the unsaved changes on top ---------- */
  var SERVER = {};           /* path -> body, as saved */
  var VIEW = {};             /* path -> body, as the page sees it */
  var pending = [];          /* {kind, path, data, res, rej} in the order made */
  var sending = [];          /* the ops in the commit now on its way */
  function rebuild() {
    SERVER = {};
    Object.keys(IDX.docs).forEach(function (p) {
      var f = FILES[IDX.docs[p]];
      if (f && f.docs[p] !== undefined) SERVER[p] = f.docs[p];
    });
    rebuildView();
  }
  function applyOp(map, op) {
    if (op.kind === 'set') map[op.path] = clone(op.data);
    else if (op.kind === 'update') map[op.path] = Object.assign({}, map[op.path] || {}, clone(op.data));
    else if (op.kind === 'delete') delete map[op.path];
  }
  function rebuildView() {
    var before = VIEW;
    VIEW = Object.assign({}, SERVER);
    sending.concat(pending).forEach(function (op) { applyOp(VIEW, op); });
    notify(before);
  }

  /* ---------- building a commit ---------- */
  /* Where each changed record goes: where it already is if it still fits, otherwise
     the newest file of its collection with room, otherwise a new file. */
  function plan(ops) {
    var idx = clone(IDX), touched = {}, files = {};
    function f(n) { if (!files[n]) files[n] = clone(FILES[n] || { docs: {} }); return files[n]; }
    function size(n) { return bytesOf(JSON.stringify(f(n))); }
    function collFiles(coll) {
      return Object.keys(idx.files).filter(function (n) { return idx.files[n].coll === coll; })
        .sort(function (a, b) { return (idx.files[a].n || 0) - (idx.files[b].n || 0); });
    }
    function newFile(coll) {
      var nums = collFiles(coll).map(function (n) { return idx.files[n].n || 0; });
      var k = nums.length ? Math.max.apply(null, nums) + 1 : 0;
      var n = fileFor(coll, k);
      idx.files[n] = { rev: 0, bytes: 0, coll: coll, n: k };
      files[n] = { docs: {} };
      return n;
    }
    var after = {};
    ops.forEach(function (op) { if (!(op.path in after)) after[op.path] = SERVER[op.path]; });
    var tmp = {};
    Object.keys(after).forEach(function (p) { if (after[p] !== undefined) tmp[p] = clone(after[p]); });
    ops.forEach(function (op) { applyOp(tmp, op); });
    Object.keys(after).forEach(function (p) {
      var cur = idx.docs[p], body = tmp[p];
      if (body === undefined) {
        if (cur) { delete f(cur).docs[p]; delete idx.docs[p]; touched[cur] = 1; }
        return;
      }
      var one = bytesOf(JSON.stringify(body)) + bytesOf(JSON.stringify(p)) + 8;
      if (one > MAX_FILE - 200) throw err('TOO_BIG', 'The record ' + p + ' is too big to save (' + one + ' bytes).');
      if (cur) {
        f(cur).docs[p] = body; touched[cur] = 1;
        if (size(cur) <= MAX_FILE) return;
        delete f(cur).docs[p];
      }
      var coll = parentOf(p), dest = null;
      collFiles(coll).reverse().some(function (n) {
        if (n === cur) return false;
        f(n).docs[p] = body;
        if (size(n) <= MAX_FILE) { dest = n; return true; }
        delete f(n).docs[p]; return false;
      });
      if (!dest) { dest = newFile(coll); f(dest).docs[p] = body; }
      idx.docs[p] = dest; touched[dest] = 1;
    });
    idx.rev = (IDX.rev || 0) + 1;
    var who = me();
    var out = [];
    Object.keys(touched).forEach(function (n) {
      var body = { docs: f(n).docs, savedBy: who.name, savedAt: new Date().toISOString() };
      var text = JSON.stringify(body);
      idx.files[n].rev = idx.rev; idx.files[n].bytes = bytesOf(text);
      out.push({ name: n, text: text, body: body });
    });
    idx.savedBy = who.name; idx.savedAt = new Date().toISOString();
    out.push({ name: 'index', text: JSON.stringify(idx), body: idx });
    return { idx: idx, files: out };
  }
  function commitBody(files, message) {
    return {
      files: files.map(function (x) { return { path: 'data/' + x.name + '.json', content: x.text }; }),
      message: message, parentSha: HEAD || 'unknown'
    };
  }
  /* GitHub moves a branch one commit at a time: a second commit sent while one is being
     made is refused. So every commit this page makes (records and kept files) waits for
     the one before it. */
  var commitChain = Promise.resolve();
  function serial(fn) {
    var p = commitChain.then(fn, fn);
    commitChain = p.then(function () {}, function () {});
    return p;
  }
  /* The relay names the current commit when it refuses a stale one. Before trusting it,
     the index is read again: if nothing of MISMO Money's moved, what this page holds IS
     that commit, and the save can go on it. */
  function learnHead(e) {
    var head = e && e.body && e.body.head;
    return refresh().then(function (moved) {
      if (head && !moved) HEAD = head;
      return moved;
    });
  }

  /* ---------- saving: one commit at a time ---------- */
  var timer = null, flushing = false, waitingSignIn = false;
  function queue(path, kind, data) {
    checkPath(path);
    if (kind === 'update' && VIEW[path] === undefined) return Promise.reject(err('not-found', 'No document to update: ' + path));
    return new Promise(function (res, rej) {
      pending.push({ kind: kind, path: path, data: data, res: res, rej: rej });
      rebuildView();
      schedule(FLUSH_MS);
    });
  }
  function schedule(ms) { if (!timer) timer = setTimeout(function () { timer = null; flush(); }, ms); }
  /* the ops that fit in one commit, oldest first */
  function nextBatch() {
    var batch = [], bytes = 0;
    for (var i = 0; i < pending.length; i++) {
      var b = bytesOf(JSON.stringify(pending[i].data || null));
      if (batch.length && bytes + b > MAX_COMMIT / 5) break;
      batch.push(pending[i]); bytes += b;
    }
    return batch;
  }
  function flush() {
    if (flushing || !pending.length) return;
    if (!(RS() && RS().token())) { waitingSignIn = true; needSignIn(); return; }
    if (RS().canEdit && !RS().canEdit(PROJECT)) {
      var refused = pending.splice(0); rebuildView();
      refused.forEach(function (op) { op.rej(err('permission-denied', 'This account can view MISMO Money but not change it.')); });
      toast('Your account can view MISMO Money but not change it. Nothing was saved.', 'bad');
      return;
    }
    flushing = true;
    var batch = nextBatch(), tries = 0;
    pending = pending.slice(batch.length); sending = batch;
    var attempt = function () {
      var p = plan(batch);
      var paths = {}; batch.forEach(function (op) { paths[op.path] = 1; });
      var msg = 'MISMO Money: ' + Object.keys(paths).slice(0, 4).join(', ') + (Object.keys(paths).length > 4 ? ' and ' + (Object.keys(paths).length - 4) + ' more' : '');
      var body = commitBody(p.files, msg), total = bytesOf(JSON.stringify(body));
      if (total > MAX_COMMIT) {
        /* too much for one request: the later half waits for the next commit */
        if (batch.length > 1) {
          var back = batch.splice(Math.ceil(batch.length / 2));
          pending = back.concat(pending); sending = batch;
          return attempt();
        }
        throw err('TOO_BIG', 'This save is too big for one commit (' + total + ' bytes).');
      }
      return serial(function () { body.parentSha = HEAD || 'unknown'; return net('POST', 'commit', body); }).then(function (b) {
        HEAD = (b && b.commit) || null;
        IDX = p.idx;
        p.files.forEach(function (x) { if (x.name !== 'index') FILES[x.name] = { docs: x.body.docs }; });
        sending = [];
        rebuild();
        batch.forEach(function (op) { op.res(); });
        saved();
      }, function (e) {
        if (e && e.status === 409 && tries < 8) {
          tries++;
          return new Promise(function (r) { setTimeout(r, tries > 1 ? 300 * tries + Math.random() * 500 : 0); })
            .then(function () { return learnHead(e); }).then(attempt);
        }
        throw e;
      });
    };
    Promise.resolve().then(attempt).catch(function (e) {
      var transient = e && (e.code === 'OFFLINE' || e.status === 401 || e.code === 'SIGNED_OUT' ||
        (e.status >= 500 && e.code !== 'TOKEN' && e.code !== 'GITHUB' && e.code !== 'REJECTED') ||
        (e.code === 'GITHUB' && (e.gh >= 500 || !e.gh && /timed? ?out|ETIMEDOUT|ECONNRESET|fetch failed/i.test(e.message || ''))));
      if (transient) {
        /* nothing is lost: the change goes back to the front of the queue */
        pending = batch.concat(pending); sending = [];
        if (e.status === 401 || e.code === 'SIGNED_OUT') waitingSignIn = true;
        else setTimeout(function () { schedule(0); }, RETRY_MS);
        problem(e);
        return;
      }
      sending = [];
      rebuildView();
      batch.forEach(function (op) { op.rej(e); });
      problem(e, true);
    }).then(function () {
      flushing = false;
      if (pending.length && !waitingSignIn) schedule(FLUSH_MS);
    });
  }
  function anyPending() { return pending.length > 0 || sending.length > 0; }
  window.addEventListener('beforeunload', function (e) {
    if (anyPending()) { e.preventDefault(); e.returnValue = 'MISMO Money is still saving.'; return e.returnValue; }
  });

  /* ---------- snapshots and listeners, in the shape the screens already use ---------- */
  function docSnap(path, data) {
    var exists = data !== null && data !== undefined;
    return { id: idOf(path), exists: exists, ref: { id: idOf(path), path: path },
      data: function () { return exists ? clone(data) : undefined; },
      metadata: { hasPendingWrites: anyPending(), fromCache: false } };
  }
  function collDocs(coll, map) {
    var out = {};
    Object.keys(map).forEach(function (p) { if (parentOf(p) === coll) out[p] = map[p]; });
    return out;
  }
  function collSnap(coll, changes) {
    var docs = collDocs(coll, VIEW);
    var list = Object.keys(docs).sort().map(function (p) { return docSnap(p, docs[p]); });
    return { docs: list, size: list.length, empty: !list.length,
      forEach: function (fn) { list.forEach(fn); },
      docChanges: function () { return changes || list.map(function (d) { return { type: 'added', doc: d }; }); },
      metadata: { hasPendingWrites: anyPending(), fromCache: false } };
  }
  var docL = [], collL = [];
  function notify(before) {
    docL.forEach(function (l) {
      var sig = JSON.stringify(VIEW[l.path]);
      if (sig === l.sig) return;
      l.sig = sig;
      try { l.cb(docSnap(l.path, VIEW[l.path])); } catch (e) { console.error(e); }
    });
    collL.forEach(function (l) {
      var docs = collDocs(l.coll, VIEW), changes = [], seen = {};
      Object.keys(docs).forEach(function (p) {
        var sig = JSON.stringify(docs[p]); seen[p] = 1;
        if (!(p in l.last)) changes.push({ type: 'added', doc: docSnap(p, docs[p]) });
        else if (l.last[p] !== sig) changes.push({ type: 'modified', doc: docSnap(p, docs[p]) });
        l.last[p] = sig;
      });
      Object.keys(l.last).forEach(function (p) {
        if (!seen[p]) { changes.push({ type: 'removed', doc: docSnap(p, null) }); delete l.last[p]; }
      });
      if (!changes.length) return;
      try { l.cb(collSnap(l.coll, changes)); } catch (e) { console.error(e); }
    });
  }
  function later(fn) { setTimeout(fn, 0); }
  function docRef(path) {
    checkPath(path);
    return {
      id: idOf(path), path: path,
      get: function () { return Promise.resolve(docSnap(path, VIEW[path])); },
      set: function (data) { return queue(path, 'set', data); },
      update: function (patch) { return queue(path, 'update', patch); },
      delete: function () { return queue(path, 'delete', null); },
      onSnapshot: function (cb) {
        var l = { path: path, cb: cb, sig: JSON.stringify(VIEW[path]) }; docL.push(l);
        later(function () { if (docL.indexOf(l) >= 0) cb(docSnap(path, VIEW[path])); });
        return function () { var i = docL.indexOf(l); if (i >= 0) docL.splice(i, 1); };
      },
      collection: function (c) { return collRef(path + '/' + c); }
    };
  }
  function collRef(coll, max) {
    var ref = {
      id: idOf(coll), path: coll,
      doc: function (id) { return docRef(coll + '/' + (id || (now().toString(36) + Math.random().toString(36).slice(2, 8)))); },
      limit: function (n) { return collRef(coll, n); },
      where: function () { return ref; }, orderBy: function () { return ref; },
      get: function () {
        var s = collSnap(coll, null);
        if (max && s.docs.length > max) { s.docs = s.docs.slice(0, max); s.size = s.docs.length; }
        return Promise.resolve(s);
      },
      onSnapshot: function (cb) {
        var l = { coll: coll, cb: cb, last: {} }; collL.push(l);
        var docs = collDocs(coll, VIEW); Object.keys(docs).forEach(function (p) { l.last[p] = JSON.stringify(docs[p]); });
        later(function () { if (collL.indexOf(l) >= 0) cb(collSnap(coll, null)); });
        return function () { var i = collL.indexOf(l); if (i >= 0) collL.splice(i, 1); };
      }
    };
    return ref;
  }
  var DB = { doc: docRef, collection: function (c) { return collRef(c); } };

  /* ---------- keeping up with everyone else (the relay has no push) ---------- */
  var lastActive = now(), polledAt = 0;
  ['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach(function (ev) {
    document.addEventListener(ev, function () { lastActive = now(); }, { capture: true, passive: true });
  });
  function poll(force) {
    if (!ready || !(RS() && RS().token()) || flushing || anyPending()) return;
    if (!force && document.visibilityState === 'hidden') return;
    var gap = now() - lastActive > IDLE_AFTER ? IDLE_POLL_MS : POLL_MS;
    if (!force && now() - polledAt < gap) return;
    polledAt = now();
    refresh().catch(function () {});
  }
  setInterval(function () { poll(false); }, 5000);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') poll(true); });

  /* ---------- who is signed in ---------- */
  function me() { var s = RS() && RS().current(); var email = (s && s.email) || ''; return { id: email, name: (s && s.name) || '', email: email }; }
  var USER = {
    can: function () { return Promise.resolve(ready); },
    me: function () { return Promise.resolve(me()); },
    profile: function () { return Promise.resolve(me()); },
    profiles: function (ids) {
      var m = me(), out = {};
      (ids || []).forEach(function (id) { if (id === m.id) out[id] = { name: m.name, email: m.email }; });
      return Promise.resolve(out);
    }
  };

  /* ---------- files handed to the person ---------- */
  var DOWNLOADS = {
    save: function (o) {
      return new Promise(function (res) {
        var data = o && o.data;
        var blob = data instanceof Blob ? data : new Blob([data], { type: (o && (o.mimeType || o.type)) || 'application/octet-stream' });
        var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = (o && o.filename) || 'download';
        document.body.appendChild(a); a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); res(); }, 1500);
      });
    }
  };

  /* ---------- kept files: files/<id> in the private repository ---------- */
  function b64(bytes) {
    var s = '', CH = 0x8000;
    for (var i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    return btoa(s);
  }
  function unb64(t) { var s = atob(t), out = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i); return out; }
  var ASSET_MAX = 3 * 1024 * 1024;   /* base64 grows a file by a third; the relay takes 5.5 MB a request */
  var ASSETS = {
    upload: function (blob) {
      return blob.arrayBuffer().then(function (buf) {
        var bytes = new Uint8Array(buf);
        if (bytes.length > ASSET_MAX) throw err('too_large', 'Files kept here can be at most 3 MB.');
        var id = ''; var r = new Uint8Array(16); crypto.getRandomValues(r);
        for (var i = 0; i < 16; i++) id += ('0' + r[i].toString(16)).slice(-2);
        var body = { files: [{ path: 'files/' + id, content: b64(bytes), encoding: 'base64' }], message: 'MISMO Money: kept file ' + id };
        var tries = 0;
        /* a new file overwrites nothing, so it needs no parent; a refusal only means another
           commit landed at the same moment, and it is simply sent again */
        var go = function () {
          return serial(function () { return net('POST', 'commit', body); }).catch(function (e) {
            if (e && e.status === 409 && tries++ < 5) return new Promise(function (r) { setTimeout(r, 400 * tries); }).then(go);
            throw e;
          });
        };
        return go().then(function () { HEAD = null; return { id: id, sizeBytes: bytes.length }; });
      });
    },
    /* a commit can add files but not remove them; the record goes, the file stays in history */
    delete: function () { return Promise.reject(err('not_supported', 'Kept files stay in the repository history.')); }
  };
  var realFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var u = typeof input === 'string' ? input : (input && input.url) || '';
    var m = /^\/_blob\/([0-9a-f]{32})$/.exec(u);
    if (!m) return realFetch(input, init);
    return net('GET', 'file/files/' + m[1]).then(function (b) {
      return new Response(new Blob([unb64(String(b.content || ''))]), { status: 200 });
    }, function (e) { return new Response('', { status: e.status || 502 }); });
  };

  /* ---------- Ask AI, through the relay's Ask route ---------- */
  function sample(prompt, opts) {
    opts = opts || {};
    if (opts.tools && opts.tools.length) return Promise.reject(err('tools_unavailable', 'Page tools are not available here.'));
    return net('POST', 'ask', { prompt: String(prompt || '') }).then(function (b) {
      var text = String((b && b.text) || '');
      if (!text) throw err('empty_completion');
      if (opts.onText) try { opts.onText({ text: text }); } catch (e) {}
      return { text: text, truncated: false };
    }, function (e) {
      var map = { RATE_LIMITED: 'rate_limited', PROMPT_TOO_BIG: 'prompt_too_large', SIGNED_OUT: 'session_expired' };
      throw err(map[e.code] || 'upstream_error', e.message);
    });
  }
  var askReady = null;
  function askCap() {
    /* an empty question costs nothing and answers NO_PROMPT when the route is ready */
    if (!askReady) askReady = net('POST', 'ask', { prompt: '' }).then(function () { return null; }, function (e) {
      return e && e.code === 'NO_PROMPT' ? sample : null;
    });
    return askReady;
  }

  /* ---------- the sign-in gate ---------- */
  var ready = false, readyWaiters = [];
  function whenReady() { return ready ? Promise.resolve() : new Promise(function (r) { readyWaiters.push(r); }); }
  var WHY = {
    UNKNOWN_PROJECT: 'The save relay doesn’t know MISMO Money yet (no "' + PROJECT + '" entry in projects.json).',
    NO_ACCESS: 'Your account doesn’t have MISMO Money yet. Ask Jonna Critchley to add you.',
    PATH_NOT_READABLE: 'The relay’s entry for MISMO Money doesn’t let it read the page (app/ must be listed as readable).',
    NOT_FOUND: 'The page files aren’t in the private repository yet.',
    TOKEN: 'The save relay’s GitHub key was refused. It needs the financials-data repository added to it.',
    GITHUB: 'GitHub refused. The save relay’s GitHub key most likely doesn’t include the financials-data repository yet.',
    CONFIG_UNAVAILABLE: 'The save relay can’t read its settings right now.',
    OFFLINE: 'MISMO Money couldn’t reach the save relay. Check your connection.'
  };
  var starting = false;
  function start() {
    var rs = RS();
    if (!rs) { window.MM_GATE && window.MM_GATE('error', 'The resources.mismo.org sign-in didn’t load. Check your connection, then reload the page.'); return; }
    if (starting || ready) return;
    starting = true;
    rs.requireAccess(PROJECT, { toolName: TOOL }).then(function () {
      if (ready) return;
      window.MM_GATE && window.MM_GATE('loading');
      /* the page's own files are read alongside the records, not after them (index.html) */
      if (window.MM_PREFETCH) window.MM_PREFETCH().catch(function () {});
      return loadAll().then(function () {
        ready = true; starting = false; resumeWrites();
        readyWaiters.splice(0).forEach(function (r) { r(); });
        if (window.MM_START) window.MM_START();
      });
    }).catch(function (e) {
      starting = false;
      if (e && e.code === 'NO_ACCESS') { rs.signIn({ reason: 'no-access', toolName: TOOL, gated: true }).catch(function () {}); return; }
      if (e && e.message === 'cancelled') return;
      window.MM_GATE && window.MM_GATE('error', (e && (WHY[e.code] || e.message)) || 'Something went wrong reading the records.');
    });
  }
  function resumeWrites() { if (waitingSignIn) { waitingSignIn = false; schedule(0); } }
  var askedSignIn = false;
  function needSignIn() {
    if (askedSignIn) return; askedSignIn = true;
    var rs = RS(); if (!rs) return;
    rs.signIn({ reason: 'expired' }).then(function () { askedSignIn = false; resumeWrites(); },
      function () { askedSignIn = false; if (anyPending()) toast('Not signed in, so your last change is not saved yet. Sign in to finish saving.', 'bad'); });
  }
  /* someone else signing in on this browser must not see the records already loaded */
  var who0 = null;
  function onSession() {
    var s = RS() && RS().current(), w = s ? String(s.email || '').toLowerCase() : null;
    if (ready && who0 && w && w !== who0) { location.reload(); return; }
    if (w) who0 = w;
    if (!ready) start(); else resumeWrites();
  }

  /* ---------- a quiet line when a save has a problem ---------- */
  var toastEl = null, toastT = null;
  function toast(text, tone) {
    if (!document.body) return;
    if (!toastEl) {
      toastEl = document.createElement('div'); toastEl.id = 'mm-savestate'; toastEl.setAttribute('role', 'status');
      toastEl.style.cssText = 'position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:9999;max-width:min(560px,calc(100vw - 32px));' +
        'padding:10px 16px;border-radius:8px;font:500 13px/1.4 "IBM Plex Sans",system-ui,sans-serif;box-shadow:0 6px 20px rgba(13,49,76,.18)';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = text;
    toastEl.style.background = tone === 'bad' ? '#A32219' : '#0d314c';
    toastEl.style.color = '#fff'; toastEl.hidden = false;
    clearTimeout(toastT); toastT = setTimeout(function () { toastEl.hidden = true; }, tone === 'bad' ? 9000 : 4000);
  }
  var troubled = false;
  function problem(e, lost) {
    status.lastError = (e && (e.code || e.message)) || 'error';
    if (lost) {
      var why = (e && (WHY[e.code] || e.message)) || 'relay error';
      toast('A change didn’t save (' + why + '). It has been taken back.', 'bad'); return;
    }
    troubled = true;
    toast(e && (e.status === 401 || e.code === 'SIGNED_OUT') ? 'Sign in again to finish saving. Nothing is lost.' : 'Not saved yet, trying again. Keep this tab open.', 'bad');
  }
  function saved() { if (troubled && !anyPending()) { troubled = false; toast('All changes saved.'); } }

  /* ---------- the door ---------- */
  window.claude = {
    use: function (cap) {
      if (cap === 'db') return whenReady().then(function () { return DB; });
      if (cap === 'user') return whenReady().then(function () { return USER; });
      if (cap === 'downloads') return Promise.resolve(DOWNLOADS);
      if (cap === 'assets') return whenReady().then(function () { return RS() && RS().canEdit(PROJECT) ? ASSETS : null; });
      if (cap === 'sample') return whenReady().then(askCap);
      return Promise.resolve(null);
    }
  };

  /* ---------- reading the page itself from the private repository ---------- */
  function readApp(path) {
    return net('GET', 'file/' + path.split('/').map(encodeURIComponent).join('/')).then(function (b) {
      return unb64(String((b && b.content) || ''));
    });
  }

  window.__mmRelay = {
    readApp: readApp, poll: function () { poll(true); }, pending: anyPending, status: status,
    view: function () { return VIEW; }, index: function () { return IDX; },
    why: function () { return WHY[status.lastError] || status.lastError || ''; },
    config: { RELAY_URL: RELAY_URL, PROJECT: PROJECT, MAX_FILE: MAX_FILE, MAX_COMMIT: MAX_COMMIT },
    /* used once, to move the records across from the Claude page: every record in
       {collection:{id:body}} is queued as a save; resolves when all are committed */
    restore: function (backup) {
      var jobs = [];
      Object.keys(backup || {}).forEach(function (c) {
        Object.keys(backup[c] || {}).forEach(function (id) { jobs.push(queue(c + '/' + id, 'set', backup[c][id])); });
      });
      return Promise.all(jobs).then(function () { return jobs.length; });
    }
  };

  function hook() {
    var rs = RS();
    if (!rs) { start(); return; }
    rs.onChange(onSession);
    onSession();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', hook); else hook();
})();
