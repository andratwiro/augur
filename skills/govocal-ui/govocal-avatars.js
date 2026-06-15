/* govocal-avatars.js — drops real, varied user faces into avatar bubbles.
   Source: randomuser.me portraits (public-domain / no attribution required).
   Fills every .av that hasn't been given an explicit background, so the hero,
   spotlight and card participant rows show a bit of human randomness instead of
   flat placeholders. Idempotent; re-callable via window.GVAvatars.fill(root). */
(function () {
  function faceURL() {
    var g = Math.random() < 0.5 ? 'men' : 'women';
    var n = Math.floor(Math.random() * 100); // randomuser has 0–99 per gender
    return 'https://randomuser.me/api/portraits/' + g + '/' + n + '.jpg';
  }
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
