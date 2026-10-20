/*
 * Remote-control navigation, modals, toasts and TV-friendly form controls.
 *
 * Focusable elements carry class "focusable". Arrow keys move focus to the
 * nearest focusable element in that direction; OK/Enter clicks it. The Magic
 * Remote pointer focuses on hover and clicks natively.
 */
(function () {
  'use strict';
  var U = SD.util;

  var KEY = {
    LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13,
    BACK: 461, ESC: 27, BACKSPACE: 8,
    RED: 403, GREEN: 404, YELLOW: 405, BLUE: 406
  };
  SD.KEY = KEY;

  // ---------- spatial navigation ----------
  function scope() {
    var modal = U.$('.modal-layer .modal');
    return modal || document;
  }
  function visible(el) {
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && !el.disabled;
  }
  function focusables() {
    return U.$$('.focusable', scope()).filter(visible);
  }

  SD.focus = function (el) {
    if (!el) { return; }
    var prev = U.$('.focused');
    if (prev && prev !== el) {
      prev.classList.remove('focused');
      if (prev.stopEditing) { prev.stopEditing(); }
    }
    el.classList.add('focused');
    if (el.tagName === 'INPUT') { /* keyboard opens on OK, not on focus */ }
    if (el.scrollIntoViewIfNeeded) { el.scrollIntoViewIfNeeded(false); }
  };
  SD.focused = function () {
    var el = U.$('.focused');
    return el && visible(el) && scope().contains(el) ? el : null;
  };
  SD.focusFirst = function (root) {
    var list = U.$$('.focusable', root || scope()).filter(visible);
    var pref = list.filter(function (e) { return e.hasAttribute('data-autofocus'); })[0];
    SD.focus(pref || list[0]);
  };

  function centre(r) { return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }

  function move(dir) {
    var cur = SD.focused();
    var list = focusables();
    if (!cur) { SD.focus(list[0]); return; }
    var cr = cur.getBoundingClientRect();
    var c = centre(cr);
    var horizontal = dir === 'left' || dir === 'right';
    var best = null, bestScore = Infinity;
    U.each(list, function (el) {
      if (el === cur) { return; }
      var r = el.getBoundingClientRect();
      var p = centre(r);
      var dx = p.x - c.x, dy = p.y - c.y;
      var primary, secondary;
      if (dir === 'left') { if (r.right > cr.left + 4) { return; } primary = -dx; secondary = Math.abs(dy); }
      if (dir === 'right') { if (r.left < cr.right - 4) { return; } primary = dx; secondary = Math.abs(dy); }
      if (dir === 'up') { if (r.bottom > cr.top + 4) { return; } primary = -dy; secondary = Math.abs(dx); }
      if (dir === 'down') { if (r.top < cr.bottom - 4) { return; } primary = dy; secondary = Math.abs(dx); }
      // Prefer targets that overlap the current element on the other axis (same row / column).
      var overlaps = horizontal
        ? (r.top < cr.bottom && r.bottom > cr.top)
        : (r.left < cr.right && r.right > cr.left);
      // Left/right never jump to another row; up/down may drift sideways if nothing is directly below.
      if (horizontal && !overlaps) { return; }
      var score = primary + secondary * 2.5 + (overlaps ? 0 : 100000);
      if (score < bestScore) { bestScore = score; best = el; }
    });
    if (best) { SD.focus(best); }
  }

  // A focused element can take over left/right (e.g. steppers) by setting el.onNavKey
  SD.handleNavKey = function (e) {
    var cur = SD.focused();
    var dirs = {}; dirs[KEY.LEFT] = 'left'; dirs[KEY.RIGHT] = 'right'; dirs[KEY.UP] = 'up'; dirs[KEY.DOWN] = 'down';
    var dir = dirs[e.keyCode];

    if (cur && cur.tagName === 'INPUT' && document.activeElement === cur) {
      // Typing in a text field: only up/down/enter leave it
      if (e.keyCode === KEY.UP || e.keyCode === KEY.DOWN || e.keyCode === KEY.ENTER) {
        cur.blur();
        if (dir) { move(dir); }
        e.preventDefault();
        return true;
      }
      return false;
    }
    if (dir) {
      if (cur && cur.onNavKey && cur.onNavKey(dir) === true) { e.preventDefault(); return true; }
      move(dir);
      e.preventDefault();
      return true;
    }
    if (e.keyCode === KEY.ENTER && cur) {
      if (cur.tagName === 'INPUT') { cur.focus(); } else if (cur.onOk) { cur.onOk(); } else { cur.click(); }
      e.preventDefault();
      return true;
    }
    return false;
  };

  document.addEventListener('mouseover', function (e) {
    var el = e.target;
    while (el && el !== document && !(el.classList && el.classList.contains('focusable'))) { el = el.parentNode; }
    if (el && el !== document && scope().contains(el)) { SD.focus(el); }
  });

  // ---------- modal ----------
  var modalStack = [];
  SD.modal = function (opts) {
    var layer = U.$('.modal-layer');
    var prevFocus = SD.focused();
    var actions = U.h('div', { 'class': 'modal-actions' });
    var box = U.h('div', { 'class': 'modal' + (opts.danger ? ' modal-danger' : '') }, [
      U.h('h2', { text: opts.title }),
      opts.body ? (typeof opts.body === 'string' ? U.h('p', { 'class': 'modal-body', text: opts.body }) : opts.body) : null,
      actions
    ]);
    var api = {
      close: function () {
        if (box.parentNode) { box.parentNode.removeChild(box); }
        modalStack.pop();
        if (!modalStack.length) { layer.classList.remove('open'); }
        if (prevFocus && document.body.contains(prevFocus)) { SD.focus(prevFocus); }
        if (opts.onClose) { opts.onClose(); }
      },
      box: box
    };
    U.each(opts.buttons || [{ label: 'OK' }], function (b, i) {
      actions.appendChild(U.h('button', {
        'class': 'btn focusable' + (b.primary ? ' btn-primary' : '') + (b.danger ? ' btn-danger' : ''),
        'data-autofocus': b.autofocus || null,
        text: b.label,
        onclick: function () {
          if (b.onClick && b.onClick(api) === false) { return; }
          api.close();
        }
      }));
    });
    layer.appendChild(box);
    layer.classList.add('open');
    modalStack.push(api);
    SD.focusFirst(box);
    return api;
  };
  SD.closeTopModal = function () {
    if (!modalStack.length) { return false; }
    modalStack[modalStack.length - 1].close();
    return true;
  };

  // ---------- toasts (in-app) ----------
  SD.toast = function (msg, kind) {
    var host = U.$('.toasts');
    var t = U.h('div', { 'class': 'toast' + (kind ? ' toast-' + kind : ''), text: msg });
    host.appendChild(t);
    setTimeout(function () { t.classList.add('show'); }, 20);
    setTimeout(function () {
      t.classList.remove('show');
      setTimeout(function () { if (t.parentNode) { t.parentNode.removeChild(t); } }, 400);
    }, kind === 'error' ? 7000 : 4000);
  };
  SD.on('notice', function (msg) { SD.toast(msg); });

  // ---------- form controls ----------
  /*
   * Stepper: a focusable row whose value changes with left/right.
   * opts: { label, values: [{value, label}], value, onChange, hint }
   */
  SD.stepper = function (opts) {
    var idx = 0;
    U.each(opts.values, function (v, i) { if (v.value === opts.value) { idx = i; } });
    var valEl = U.h('span', { 'class': 'stepper-value' });
    var row = U.h('div', { 'class': 'field stepper focusable' }, [
      U.h('span', { 'class': 'field-label', text: opts.label }),
      U.h('span', { 'class': 'stepper-ctl' }, [U.h('span', { 'class': 'chev', text: '‹' }), valEl, U.h('span', { 'class': 'chev', text: '›' })]),
      opts.hint ? U.h('span', { 'class': 'field-hint', text: opts.hint }) : null
    ]);
    function render() { valEl.textContent = opts.values[idx].label; }
    function set(i) {
      idx = U.clamp(i, 0, opts.values.length - 1);
      render();
      if (opts.onChange) { opts.onChange(opts.values[idx].value); }
    }
    /*
     * Remote: arrows move between controls as normal. Press OK to start editing,
     * then left/right change the value; OK, Back, up or down finish editing.
     */
    var editing = false;
    function setEditing(on) {
      editing = on;
      row.classList.toggle('editing', on);
    }
    row.stopEditing = function () { setEditing(false); };
    row.isEditing = function () { return editing; };
    row.onOk = function () { setEditing(!editing); };
    row.onNavKey = function (dir) {
      if (!editing) { return false; }
      if (dir === 'left') { set(idx - 1); return true; }
      if (dir === 'right') { set(idx + 1); return true; }
      setEditing(false); // up/down: finish and move on
      return false;
    };
    row.addEventListener('click', function (e) {
      // Magic Remote pointer: click left part to decrease, right part to increase
      if (!e.clientX) { return; }
      var r = row.getBoundingClientRect();
      set(e.clientX < r.left + r.width * 0.6 ? idx - 1 : idx + 1);
    });
    row.getValue = function () { return opts.values[idx].value; };
    row.setValues = function (values, value) {
      opts.values = values;
      idx = 0;
      U.each(values, function (v, i) { if (v.value === value) { idx = i; } });
      render();
    };
    render();
    return row;
  };

  // Text input row; the webOS on-screen keyboard opens when OK is pressed.
  SD.textField = function (opts) {
    var input = U.h('input', {
      'class': 'focusable text-input', type: opts.secret ? 'password' : 'text', value: opts.value || '',
      placeholder: opts.placeholder || '', autocomplete: 'off', spellcheck: 'false'
    });
    input.addEventListener('change', function () { if (opts.onChange) { opts.onChange(input.value.trim()); } });
    input.addEventListener('blur', function () { if (opts.onChange) { opts.onChange(input.value.trim()); } });
    var row = U.h('label', { 'class': 'field' }, [
      U.h('span', { 'class': 'field-label', text: opts.label }),
      input,
      opts.hint ? U.h('span', { 'class': 'field-hint', text: opts.hint }) : null
    ]);
    row.input = input;
    return row;
  };

  // Range of numeric options for a stepper
  SD.range = function (from, to, step, fmt) {
    var out = [];
    for (var v = from; v <= to + 1e-9; v += step) {
      var r = Math.round(v * 1000) / 1000;
      out.push({ value: r, label: fmt ? fmt(r) : String(r) });
    }
    return out;
  };
})();
