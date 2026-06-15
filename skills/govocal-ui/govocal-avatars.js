/* govocal-avatars.js — drops varied human faces into avatar bubbles to give them
   a bit of life. Faces are a bundled set of 10 CC0, AI-generated portraits (no real
   person, no attribution) stored in ./avatars/, optimised to 128px. Fills every .av
   that hasn't been given an explicit background (hero, spotlight, card participant
   rows). Idempotent; re-callable via window.GVAvatars.fill(root). */
(function () {
  // Resolve ./avatars/ from THIS script's own URL, so background-image URLs work
  // no matter which page (pages/* or components/*) pulls the script in.
  var BASE = (function () {
    var s = document.currentScript;
    if (!s) {
      var ss = document.getElementsByTagName('script');
      for (var i = 0; i < ss.length; i++) { if (/govocal-avatars\.js/.test(ss[i].src)) { s = ss[i]; break; } }
    }
    return s ? s.src.replace(/govocal-avatars\.js(?:\?.*)?$/, 'avatars/') : 'avatars/';
  })();
  var FACES = ['face-01.jpg', 'face-02.jpg', 'face-03.jpg', 'face-04.jpg', 'face-05.jpg',
               'face-06.jpg', 'face-07.jpg', 'face-08.jpg', 'face-09.jpg', 'face-10.jpg'];
  function faceURL() { return BASE + FACES[Math.floor(Math.random() * FACES.length)]; }
  function fill(root) {
    var scope = root || document;
    scope.querySelectorAll('.av').forEach(function (el) {
      if (el.dataset.face !== undefined) return;            // already done
      var inline = el.getAttribute('style') || '';
      if (/background/i.test(inline)) return;               // respect explicit art (e.g. gradient avatars)
      el.dataset.face = '';
      el.style.backgroundImage = "url('" + faceURL() + "')";
      el.style.backgroundSize = 'cover';
      el.style.backgroundPosition = 'center';
      el.style.backgroundColor = 'var(--gv-grey-200)';      // fallback tint while the face loads
    });
  }
  if (document.readyState !== 'loading') fill();
  else document.addEventListener('DOMContentLoaded', function () { fill(); });
  window.GVAvatars = { fill: fill, faceURL: faceURL };
})();
