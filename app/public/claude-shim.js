/* Lớp nối giữa trang (viết cho kho lưu trữ của claude.ai: window.claude.use("db" | "assets" | "user" | "downloads"))
   và API của máy chủ Sổ phí (/api/...). Trang gần như giữ nguyên, chỉ đổi nơi lưu dữ liệu. */
(function () {
  "use strict";
  var SOPHI = (window.SOPHI = { me: null, err: "" });

  function fail(r, j) {
    var e = new Error((j && j.message) || "Máy chủ trả lỗi " + r.status + ".");
    e.status = r.status;
    e.code = r.status === 403 ? "invalid_argument" : r.status === 413 ? "too_large" : r.status === 429 ? "rate_limited" : (j && j.code) || "http_" + r.status;
    return e;
  }
  function req(method, url, body, headers) {
    return fetch(url, { method: method, body: body, headers: headers || {}, credentials: "same-origin", redirect: "follow" }).then(function (r) {
      var ct = r.headers.get("content-type") || "";
      // phiên Cloudflare Access hết hạn: fetch bị chuyển sang trang đăng nhập (HTML)
      if (r.ok && /^\/api\//.test(url) && ct.indexOf("json") < 0) { var e0 = new Error("Phiên đăng nhập đã hết hạn. Tải lại trang (F5) để đăng nhập lại."); e0.code = "auth"; throw e0; }
      if (r.ok) return ct.indexOf("json") >= 0 ? r.json() : r.text();
      return r.json().catch(function () { return null; }).then(function (j) { throw fail(r, j); });
    }, function () {
      var e = new Error("Không kết nối được máy chủ hoặc phiên đăng nhập đã hết hạn. Tải lại trang (F5).");
      e.code = "network"; throw e;
    });
  }
  SOPHI.req = req;

  /* ---------------- db: collection(...).onSnapshot / doc(...).set / delete, làm mới theo bộ đếm /api/rev */
  var listeners = {}, cache = {}, revs = {}, polling = null;
  function snapOf(col) {
    var docs = (cache[col] || []).map(function (d) {
      return { id: d.id, exists: true, data: function () { return JSON.parse(JSON.stringify(d.data)); } };
    });
    return { docs: docs, size: docs.length, empty: !docs.length, metadata: { fromCache: false, hasPendingWrites: false } };
  }
  function load(col) {
    return req("GET", "/api/c/" + col).then(function (j) {
      // máy chủ trả thông tin phụ (người lưu, nguồn file, chờ đọc…) trong meta; gộp vào data như trang cũ mong đợi
      cache[col] = (j.docs || []).map(function (d) {
        if (d.meta) Object.keys(d.meta).forEach(function (k) { d.data[k] = d.meta[k]; });
        return { id: d.id, data: d.data };
      });
      (listeners[col] || []).forEach(function (l) { try { l.next(snapOf(col)); } catch (e) { console.error(e); } });
    }, function (e) {
      (listeners[col] || []).forEach(function (l) { if (l.err) try { l.err(e); } catch (x) { console.error(x); } });
    });
  }
  function poll() {
    return req("GET", "/api/rev").then(function (r) {
      var ps = [];
      Object.keys(listeners).forEach(function (col) {
        if (r[col] !== revs[col]) { revs[col] = r[col]; ps.push(load(col)); }
      });
      return Promise.all(ps);
    }, function (e) { SOPHI.err = e.message; });
  }
  function startPolling() {
    if (polling) return;
    // 20 giây: đủ để thấy thay đổi của người khác; thay đổi của chính mình làm mới ngay sau khi lưu.
    // Gói free giới hạn 100.000 request/ngày cho cả trang, webhook và agent.
    polling = setInterval(function () { if (!document.hidden) poll(); }, 20000);
    document.addEventListener("visibilitychange", function () { if (!document.hidden) poll(); });
  }
  var db = {
    collection: function (col) {
      return {
        onSnapshot: function (next, err) {
          var l = { next: next, err: err };
          (listeners[col] = listeners[col] || []).push(l);
          load(col); startPolling();
          return function () { listeners[col] = (listeners[col] || []).filter(function (x) { return x !== l; }); };
        },
        doc: function (id) {
          var url = "/api/c/" + col + "/" + encodeURIComponent(id);
          return {
            set: function (data) { return req("PUT", url, JSON.stringify(data), { "content-type": "application/json" }).then(function () { return poll(); }); },
            delete: function () { return req("DELETE", url).then(function () { return poll(); }); }
          };
        }
      };
    }
  };

  /* ---------------- assets: file gốc lưu ở R2 / thư mục local, đọc lại qua /_blob/<id> */
  function sha256(buf) {
    if (!window.crypto || !crypto.subtle) return Promise.resolve("");
    return crypto.subtle.digest("SHA-256", buf).then(function (h) { return Array.from(new Uint8Array(h)).map(function (x) { return ("0" + x.toString(16)).slice(-2); }).join(""); }, function () { return ""; });
  }
  var assets = {
    upload: function (blob, opt) {
      return blob.arrayBuffer().then(function (buf) {
        return sha256(buf).then(function (h) {
          var hd = { "content-type": (opt && opt.type) || blob.type || "application/octet-stream" };
          if (h) hd["x-sophi-sha256"] = h;
          return req("POST", "/api/blobs", buf, hd);
        });
      }).then(function (j) { return { id: j.id }; });
    },
    delete: function (id) { return req("DELETE", "/api/blobs/" + encodeURIComponent(id)); }
  };

  var meP = req("GET", "/api/me").then(function (me) { SOPHI.me = me; return me; }, function (e) { SOPHI.err = e.message; return null; });
  var user = { can: function (perm) { return meP.then(function (me) { return !!(me && perm === "data.write" && me.canWrite); }); } };

  window.claude = {
    use: function (name) {
      if (name === "db") return meP.then(function (me) { return me ? db : null; });
      if (name === "assets") return meP.then(function (me) { return me && me.canWrite ? assets : null; });
      if (name === "user") return meP.then(function (me) { return me ? user : null; });
      return Promise.resolve(null); // downloads: trang tự tải bằng thẻ <a download>
    }
  };
})();
