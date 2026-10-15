(function () {
  // mobile menu
  var menuBtn = document.getElementById('menu-btn');
  var menu = document.getElementById('mobile-menu');
  var icon = document.getElementById('menu-icon');
  var BARS = 'M3 6h14M3 10h14M3 14h14';
  var CROSS = 'M5 5l10 10M15 5L5 15';
  function setMenu(open) {
    menuBtn.setAttribute('aria-expanded', String(open));
    menu.hidden = !open;
    icon.setAttribute('d', open ? CROSS : BARS);
  }
  menuBtn.addEventListener('click', function () {
    setMenu(menuBtn.getAttribute('aria-expanded') !== 'true');
  });
  menu.addEventListener('click', function (e) {
    if (e.target.closest('a')) setMenu(false);
  });
  window.matchMedia('(min-width: 900px)').addEventListener('change', function (e) {
    if (e.matches) setMenu(false);
  });

  // FAQ accordion: one open at a time
  var buttons = document.querySelectorAll('.acc-btn');
  buttons.forEach(function (btn) {
    btn.addEventListener('click', function () {
      var wasOpen = btn.getAttribute('aria-expanded') === 'true';
      buttons.forEach(function (b) {
        b.setAttribute('aria-expanded', 'false');
        document.getElementById(b.getAttribute('aria-controls')).hidden = true;
      });
      if (!wasOpen) {
        btn.setAttribute('aria-expanded', 'true');
        document.getElementById(btn.getAttribute('aria-controls')).hidden = false;
      }
    });
  });

  // enquiry form (no backend)
  var form = document.getElementById('enquiry');
  var thanks = document.getElementById('thanks');
  var rules = [
    ['f-name', 'e-name', 'Please enter your name.'],
    ['f-email', 'e-email', 'Please enter a valid email address.'],
    ['f-dates', 'e-dates', 'Please tell us your travel dates.'],
    ['f-msg', 'e-msg', 'Please add a short message.']
  ];
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var firstBad = null;
    rules.forEach(function (r) {
      var input = document.getElementById(r[0]);
      var err = document.getElementById(r[1]);
      var v = input.value.trim();
      var ok = v !== '' && (r[0] !== 'f-email' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v));
      input.setAttribute('aria-invalid', String(!ok));
      err.textContent = ok ? '' : r[2];
      if (!ok && !firstBad) firstBad = input;
    });
    if (firstBad) { thanks.hidden = true; firstBad.focus(); return; }
    form.reset();
    thanks.hidden = false;
    thanks.focus && thanks.setAttribute('tabindex', '-1');
    thanks.focus();
  });
})();
