// The Floor — activity widget. Drop into theradicalparty.com to pull lurkers in:
//   <script src="https://floor.theradicalparty.com/widget.js" defer></script>
// It polls the live-activity feed and shows a floating "on the floor now" pill
// plus, when a proposal is being argued, a "N arguing about X" call-to-action.
// If the page exposes window.RADICAL_UID, links carry it so identity flows through.
(function () {
  var BASE = 'https://floor.theradicalparty.com';
  function resolveUid() {
    if (window.RADICAL_UID) return window.RADICAL_UID;
    try {
      var ru = JSON.parse(localStorage.getItem('radical_user') || 'null');
      if (ru && ru.id) return ru.id;
    } catch (e) {}
    return localStorage.getItem('radical_user_id') || localStorage.getItem('userId') || '';
  }
  var uid = resolveUid();
  var suffix = uid ? ('?uid=' + encodeURIComponent(uid)) : '';

  var css = `
  #rad-floor{position:fixed;right:18px;bottom:18px;z-index:9999;font-family:'IBM Plex Mono',ui-monospace,monospace;max-width:320px}
  #rad-floor *{box-sizing:border-box}
  #rad-floor .fp{display:flex;align-items:center;gap:9px;background:#12100d;border:1px solid #FF2D55;color:#F0EDE6;
    padding:11px 15px;border-radius:100px;font-size:13px;cursor:pointer;box-shadow:0 8px 30px #0009;text-decoration:none}
  #rad-floor .fp:hover{background:#1a1712}
  #rad-floor .fd{width:9px;height:9px;border-radius:50%;background:#FF2D55;box-shadow:0 0 10px #FF2D55;animation:radpulse 1.6s infinite}
  #rad-floor .fn{font-weight:700;color:#FF2D55}
  #rad-floor .hot{margin-top:10px;background:#12100d;border:1px solid #241f18;border-radius:14px;padding:12px 14px;
    color:#F0EDE6;font-size:12.5px;text-decoration:none;display:block;box-shadow:0 8px 30px #0009}
  #rad-floor .hot:hover{border-color:#FF2D55}
  #rad-floor .hot b{color:#FF2D55}
  #rad-floor .hot .tp{color:#F0EDE6;margin-top:4px;font-family:system-ui,sans-serif;font-size:13px;line-height:1.35;
    display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
  #rad-floor .hot .go{color:#9c948a;margin-top:7px;font-size:11px}
  @keyframes radpulse{0%,100%{opacity:1}50%{opacity:.35}}
  `;
  var style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  var box = document.createElement('div');
  box.id = 'rad-floor';
  document.body.appendChild(box);

  function render(d) {
    var online = (d && d.online) || 0;
    var hot = (d && d.hot && d.hot[0]) || null;
    var pill = online > 0
      ? '<span class="fd"></span><span><span class="fn">' + online + '</span> on the floor</span>'
      : '<span class="fd"></span><span>Enter <span class="fn">The Floor</span></span>';
    var html = '<a class="fp" href="' + BASE + '/' + suffix + '" target="_blank">' + pill + '</a>';
    if (hot && hot.count > 0) {
      var link = BASE + '/#/' + encodeURIComponent(hot.room) + (uid ? ('?uid=' + encodeURIComponent(uid)) : '');
      html += '<a class="hot" href="' + link + '" target="_blank">' +
        '<b>🔥 ' + hot.count + ' arguing right now</b>' +
        '<div class="tp">' + escapeHtml(hot.topic || 'a live proposal') + '</div>' +
        '<div class="go">Jump into the debate →</div></a>';
    }
    box.innerHTML = html;
  }
  function escapeHtml(s){return String(s).replace(/[&<>"]/g,function(c){return({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c];});}

  function poll() {
    fetch(BASE + '/api/activity').then(function (r) { return r.json(); })
      .then(function (d) { render(d || {}); })
      .catch(function () { render({}); });
  }
  poll();
  setInterval(poll, 15000);
})();
