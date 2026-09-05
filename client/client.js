// dsh-composer-upload client half.
// Adds two controls to the composer via official slots (no vendor edits):
//  - UploadButton  -> conversation.input.left  : paperclip; images go through
//    the built-in image-draft pipeline; other files upload to /api/_upload and
//    their `.dsh-uploads/...` path is appended to the draft for the agent.
//  - ContinueButton -> conversation.input.right: "继续" one-tap resume: writes
//    "继续" into the empty draft and submits, so after a server restart the
//    user does not have to type text to wake the agent again.
// Written as a self-contained module (no build step): served verbatim at
// /plugins/<id>/client.js and reloaded on page refresh (no-cache).
window.__ModuleLoader__.load({
  id: 'dsh-composer-upload',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var react = require('react');
    var h = react.createElement;

    var name = 'dsh-composer-upload';
    var inject = ['slots', 'sessions', 'remote'];

    var IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
    var MAX_FILE_BYTES = 48 * 1024 * 1024;
    var LABEL = '\u4E0A\u4F20\u56FE\u7247/\u6587\u4EF6'; // 上传图片/文件
    var CONTINUE_LABEL = '\u7EE7\u7EED'; // 继续
    var CONTINUE_HINT = '\u6709\u672A\u5B8C\u6210\u4EFB\u52A1\u5219\u9759\u9ED8\u7EED\u8DD1\uFF1B\u5426\u5219\u53D1\u9001\u4E00\u6761\u4E0D\u53EF\u89C1\u6D88\u606F\u5524\u9192\u667A\u80FD\u4F53\u7EE7\u7EED\uFF08\u4E0D\u4EA7\u751F\u660E\u6587\uFF09'; // 有未完成任务则静默续跑；否则发送一条不可见消息唤醒智能体继续（不产生明文）

    // Captured lazily from the client context; resolved at click time so
    // ordering against the conversation plugin never matters.
    var resolveController = null;
    // Client context + goal helpers for the silent "continue" action (no text
    // is ever written to the draft or the conversation; this mirrors the goal
    // dock's resume button: remote.goals.resume(sessionId, {id, revision})).
    var actx = null;
    function goalSnapshot(sessionId) {
      try {
        if (!actx || sessionId === undefined || sessionId === null) return undefined;
        var binding = actx.sessions && actx.sessions.binding(sessionId);
        var projection = binding && binding.session && binding.session.projections
          ? binding.session.projections.faceOf('goal')
          : undefined;
        return projection ? projection.getSnapshot() : undefined;
      } catch (e) { return undefined; }
    }
    function goalResumable(sessionId) {
      var snap = goalSnapshot(sessionId);
      // Show the continue control whenever a non-complete goal exists for the
      // session (active / paused / blocked). Client goal projections do not
      // reliably expose the armed flag, so do not filter on it here; the server
      // goals.resume() call is the source of truth and any refusal is surfaced
      // by the button's transient note.
      return !!(snap && snap.goal && snap.goal.phase && snap.goal.phase !== 'complete');
    }
    async function resumeGoalSilently(sessionId) {
      var snap = goalSnapshot(sessionId);
      if (!snap || !snap.goal || !actx || !actx.remote) return { ok: false };
      try {
        return await actx.remote.goals.resume(sessionId, { id: snap.goal.id, revision: snap.goal.revision });
      } catch (e) { return { ok: false, error: e }; }
    }

    var btnBase = {
      boxSizing: 'border-box',
      height: 26,
      minWidth: 26,
      padding: 0,
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      border: '1px solid transparent',
      borderRadius: 6,
      background: 'transparent',
      color: 'var(--dsw-alias-label-secondary,#8b93a1)',
      cursor: 'pointer',
      outline: 'none',
      transition: 'background .12s ease, color .12s ease',
    };
    var btnHover = {
      background: 'var(--dsw-alias-bg-hover, rgba(127,127,127,.14))',
      color: 'var(--dsw-alias-label-primary,inherit)',
    };
    var noteStyle = {
      position: 'fixed',
      left: '50%',
      bottom: 88,
      transform: 'translateX(-50%)',
      zIndex: 2147483000,
      maxWidth: 'min(90vw, 560px)',
      boxSizing: 'border-box',
      padding: '8px 14px',
      borderRadius: 10,
      fontSize: 13,
      lineHeight: 1.45,
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
      boxShadow: '0 4px 18px rgba(0,0,0,.10)',
      color: 'var(--dsw-alias-label-primary,#1f2329)',
      background: 'var(--dsw-alias-bg-layer-2,#ffffff)',
      border: '1px solid var(--dsw-alias-border-l2,#e5e7eb)',
      pointerEvents: 'none',
    };

    function UploadButton(props) {
      var useInput = props.useInput;
      // Session-scope slot seats are guaranteed the useInput standard hook by
      // the conversation provider, so call it unconditionally (React rules).
      var liveDraft = useInput(function (s) { return s.draft; });
      var draftRef = react.useRef(liveDraft);
      draftRef.current = liveDraft;
      var actionsRef = react.useRef(props.inputActions ?? null);
      actionsRef.current = props.inputActions ?? null;
      var inputRef = react.useRef(props.input ?? null);
      inputRef.current = props.input ?? null;
      var sessionRef = react.useRef(props.sessionId ?? (props.session ? props.session.id : undefined));
      sessionRef.current = props.sessionId ?? (props.session ? props.session.id : undefined);

      var busyRef = react.useRef(false);
      var timerRef = react.useRef(null);
      var aliveRef = react.useRef(true);
      var pendingRef = react.useRef('');
      var rootRef = react.useRef(null);
      var [busy, setBusy] = react.useState(false);
      var [note, setNote] = react.useState(null);
      var [hover, setHover] = react.useState(false);

      react.useEffect(function () {
        return function () {
          aliveRef.current = false;
          if (timerRef.current) clearTimeout(timerRef.current);
        };
      }, []);

      // Make the attach button sit between "+commands" and the permission
      // (Full access) cluster. The official conversation.input.left seat renders
      // AFTER that cluster, so reorder with flex/grid `order`. The slot renderer
      // may wrap each entry in an extra element, therefore find the flex/grid
      // toolbar ancestor and order that ancestor's direct children.
      react.useEffect(function () {
        var wrap = rootRef.current;
        if (!wrap || !window.getComputedStyle) return;
        var tools = wrap.parentElement;
        var display = '';
        while (tools && !(tools.hasAttribute && tools.hasAttribute('data-composer-card'))) {
          display = window.getComputedStyle(tools).display || '';
          if (/flex|grid/.test(display)) break;
          tools = tools.parentElement;
        }
        if (!tools || !/flex|grid/.test(display)) return;
        var entry = wrap;
        while (entry.parentElement && entry.parentElement !== tools) entry = entry.parentElement;
        var kids = Array.prototype.slice.call(tools.children);
        var plus = kids[0];
        var modes = kids[1];
        if (!plus || !modes || modes === entry) return;
        plus.style.order = '0';
        entry.style.order = '1';
        modes.style.order = '2';
        entry.style.marginLeft = '4px';
        entry.style.marginRight = '4px';
      }, []);

      function showNote(text) {
        if (!aliveRef.current) return;
        if (timerRef.current) clearTimeout(timerRef.current);
        setNote(text);
        timerRef.current = setTimeout(function () {
          if (aliveRef.current) setNote(null);
        }, 4500);
      }

      var input = inputRef.current;
      var disabled = !actionsRef.current || !input || input.phase !== 'plain';

      function readB64(file) {
        return new Promise(function (resolve, reject) {
          var reader = new FileReader();
          reader.onload = function () { resolve(String(reader.result)); };
          reader.onerror = function () { reject(reader.error || new Error('FileReader failed')); };
          reader.readAsDataURL(file);
        });
      }

      async function uploadGenericFile(file) {
        if (busyRef.current) return;
        if (!actionsRef.current) return;
        if (file.size > MAX_FILE_BYTES) {
          showNote(file.name + ': \u6587\u4EF6\u8D85\u8FC7 48 MB \u4E0A\u9650');
          return;
        }
        busyRef.current = true;
        setBusy(true);
        try {
          var dataUrl = await readB64(file);
          var comma = dataUrl.indexOf(',');
          var base64 = comma === -1 ? dataUrl : dataUrl.slice(comma + 1);
          var response = await fetch('/api/_upload', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: file.name, data: base64 }),
          });
          var payload = await response.json().catch(function () { return null; });
          if (!response.ok || !payload || payload.ok !== true) {
            showNote(file.name + ': \u4E0A\u4F20\u5931\u8D25 (HTTP ' + response.status + ')');
            return;
          }
          // Clean bubble: show only the file NAME (no path). All uploads land
          // in the fixed global dir <server cwd>/.dsh-uploads; the agent
          // resolves the file there by name, so no search is needed. See README
          // for the convention.
          var storedName = typeof payload.name === 'string' && payload.name.length > 0 ? payload.name : file.name;
          if (aliveRef.current) pendingRef.current += '\u{1F4CE} ' + storedName + '\n';
          return storedName;
        } catch (error) {
          showNote(file.name + ': ' + (error && error.message ? error.message : String(error)));
        } finally {
          busyRef.current = false;
          setBusy(false);
        }
      }

      async function onFilesChosen(fileInput) {
        var files = Array.from(fileInput.files || []);
        if (files.length === 0) return;
        var actions = actionsRef.current;
        if (!actions) return;
        var images = files.filter(function (f) { return IMAGE_TYPES.has(f.type); });
        var others = files.filter(function (f) { return !IMAGE_TYPES.has(f.type); });
        if (images.length > 0) {
          var controller = resolveController ? resolveController(sessionRef.current) : null;
          if (!controller) {
            showNote('\u56FE\u7247\u6682\u4E0D\u53EF\u7528\uFF1A\u4F1A\u8BDD\u670D\u52A1\u672A\u5C31\u7EEA'); // 图片暂不可用：会话服务未就绪
          } else {
            try {
              var created = controller.createDraftImages(images);
              if (!actions.addImages(created.map(function (a) { return a.id; }))) {
                controller.releaseDraftImages(created);
                showNote('\u5F53\u524D\u65E0\u6CD5\u6DFB\u52A0\u56FE\u7247'); // 当前无法添加图片
              }
            } catch (error) {
              showNote(error && error.message ? error.message : String(error));
            }
          }
        }
        for (var i = 0; i < others.length; i++) await uploadGenericFile(others[i]);
        var appended = pendingRef.current;
        if (appended !== '') {
          pendingRef.current = '';
          var cur = draftRef.current;
          var sep = cur === '' || /\n$/.test(cur) ? '' : '\n';
          actions.setDraft(cur + sep + appended);
        }
      }

      var icon = h('svg', {
        viewBox: '0 0 24 24', width: '16', height: '16', 'aria-hidden': true,
        fill: 'none', stroke: 'currentColor', strokeWidth: 2,
        strokeLinecap: 'round', strokeLinejoin: 'round', style: { display: 'block' },
      }, h('path', { d: 'M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48' }));

      var disabledAttach = disabled || busy;
      var attachStyle = Object.assign(
        {},
        btnBase,
        { position: 'relative', overflow: 'hidden', cursor: disabledAttach ? 'default' : 'pointer' },
        hover ? btnHover : null,
        disabledAttach ? { opacity: 0.55 } : null,
      );
      var fileOverlayStyle = {
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        opacity: 0,
        margin: 0,
        cursor: 'inherit',
        boxSizing: 'border-box',
      };
      // Native <label>+<input type=file> overlay: the click lands directly on
      // the file input, so it works inside sandboxed/embedded iframes (Obsidian)
      // where a programmatic el.click() on a dynamically created input is
      // silently ignored.
      var children = [
        h('label', {
          key: 'attach',
          title: LABEL,
          'aria-label': LABEL,
          'data-composer-upload': true,
          onMouseEnter: function () { setHover(true); },
          onMouseLeave: function () { setHover(false); },
          onFocus: function () { setHover(true); },
          onBlur: function () { setHover(false); },
          style: attachStyle,
        }, [
          busy ? h('span', {
            key: 'spinner',
            style: {
              display: 'block', width: 12, height: 12, borderRadius: '50%',
              border: '2px solid var(--dsw-alias-label-tertiary,#b9c0cc)',
              borderTopColor: 'transparent',
              animation: 'dsh-composer-upload-spin .8s linear infinite',
            },
          }) : icon,
          h('input', {
            key: 'file',
            type: 'file',
            multiple: true,
            tabIndex: -1,
            disabled: disabledAttach,
            'aria-hidden': true,
            style: fileOverlayStyle,
            onChange: function (e) {
              onFilesChosen(e.currentTarget);
              e.currentTarget.value = '';
            },
          }),
        ]),
      ];
      if (note) children.push(h('div', { key: 'note', role: 'status', style: noteStyle }, note));
      return h('div', { ref: rootRef, style: { display: 'inline-flex', alignItems: 'center' } }, children);
    }

    // "Continue / wake" control: shown whenever the composer is idle and empty
    // (works right after a dsh restart). Click:
    //  - a resumable goal exists  -> silent goals.resume (no text anywhere);
    //  - otherwise                -> POST /api/_wake, a host-side silent wake
    //    that drives one internal continuation (never rendered as chat text).
    function ContinueButton(props) {
      var useInput = props.useInput;
      var useSession = props.useSession;
      var draft = useInput(function (s) { return s.draft; });
      var running = useSession(function (s) { return s.running; }) || false;
      var subagent = useSession(function (s) { return s.subagent; }) || null;
      var actionsRef = react.useRef(props.inputActions ?? null);
      actionsRef.current = props.inputActions ?? null;
      var sessionId = props.sessionId ?? (props.session ? props.session.id : undefined);
      var [hover, setHover] = react.useState(false);
      var [busy, setBusy] = react.useState(false);
      var [note, setNote] = react.useState(null);
      var noteTimer = react.useRef(null);
      if (running || subagent !== null || draft.trim() !== '') return null;

      function flashNote(text) {
        if (noteTimer.current) clearTimeout(noteTimer.current);
        setNote(text);
        noteTimer.current = setTimeout(function () { setNote(null); }, 5000);
      }
      async function invisibleWake() {
        try {
          var response = await fetch('/api/_wake', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: sessionId || null }),
          });
          var payload = await response.json().catch(function () { return null; });
          setBusy(false);
          if (!response.ok || !payload || payload.ok !== true) {
            flashNote('\u5524\u9192\u5931\u8D25\uFF1A' + ((payload && (payload.error || payload.message)) || ('HTTP ' + response.status))); // 唤醒失败：<原因>
          }
        } catch (error) {
          setBusy(false);
          flashNote('\u5524\u9192\u5931\u8D25\uFF1A' + (error && error.message ? error.message : String(error))); // 唤醒失败
        }
      }
      function onContinue() {
        if (busy) return;
        setBusy(true);
        if (goalResumable(sessionId)) {
          resumeGoalSilently(sessionId).then(function (r) {
            setBusy(false);
            if (!r) { flashNote('\u6062\u590D\u5931\u8D25\uFF1A\u6CA1\u6709\u53EF\u7EE7\u7EED\u7684\u4EFB\u52A1'); return; } // 恢复失败：没有可继续的任务
            if (r.ok !== true) {
              var err = r.error || {};
              flashNote('\u4EFB\u52A1\u6062\u590D\u5931\u8D25\uFF1A' + (err.message || err.code || '\u672A\u77E5\u539F\u56E0')); // 任务恢复失败：<原因>
            }
          });
        } else {
          invisibleWake();
        }
      }

      var style = Object.assign(
        {},
        btnBase,
        { width: 'auto', paddingLeft: 8, paddingRight: 8, fontSize: 12, whiteSpace: 'nowrap' },
        hover ? btnHover : null,
        busy ? { opacity: 0.55, cursor: 'default' } : null,
      );
      var children = [
        h('button', {
          key: 'continue',
          type: 'button',
          title: CONTINUE_HINT,
          'aria-label': CONTINUE_LABEL,
          'data-composer-continue': true,
          disabled: busy,
          onMouseDown: function (e) { e.preventDefault(); },
          onClick: onContinue,
          onMouseEnter: function () { setHover(true); },
          onMouseLeave: function () { setHover(false); },
          onFocus: function () { setHover(true); },
          onBlur: function () { setHover(false); },
          style: style,
        }, [
          h('span', { key: 'g', style: { marginRight: 4, fontSize: 10 } }, '\u25B6'),
          h('span', { key: 't' }, CONTINUE_LABEL),
        ]),
      ];
      if (note) children.push(h('div', { key: 'note', role: 'status', style: noteStyle }, note));
      return h('div', { style: { display: 'inline-flex', alignItems: 'center', position: 'relative' } }, children);
    }

    // Embedded (Obsidian iframe) link handling: browser popups are blocked in a
    // sandboxed iframe, so http(s) link clicks are forwarded to the Obsidian
    // host, which opens the system browser (dsh-harness handles 'dsh-open-url').
    function installExternalLinkBridge() {
      try {
        if (window.self === window.top) return; // top-level: default anchor behavior
        var seen = false;
        document.addEventListener('click', function (ev) {
          var t = ev.target;
          var a = t && t.closest ? t.closest('a[href]') : null;
          if (!a) return;
          var href = a.getAttribute('href') || '';
          if (!/^https?:\/\//i.test(href)) return;
          ev.preventDefault();
          var sender = (window.parent || window.top);
          sender.postMessage({ type: 'dsh-open-url', url: a.href }, '*');
          seen = true;
        }, true);
      } catch (e) { /* best-effort */ }
    }

    function apply(ctx) {
      actx = ctx;
      installExternalLinkBridge();

      // Clipboard resilience for embedded hosts (Obsidian iframe etc.): the UI
      // only falls back to execCommand when the async Clipboard API is MISSING;
      // when the API exists but is REJECTED (permissions policy on cross-origin
      // iframes) the copy silently fails. Wrap writeText so a rejection retries
      // with the classic textarea+execCommand fallback. Harmless on normal tabs.
      try {
        var clipboardNav = window.navigator;
        if (clipboardNav && clipboardNav.clipboard && typeof clipboardNav.clipboard.writeText === 'function' && !clipboardNav.clipboard.__dshClipboardFallback) {
          var nativeWriteText = clipboardNav.clipboard.writeText.bind(clipboardNav.clipboard);
          var execCopy = function (text) {
            if (typeof document.execCommand !== 'function') return Promise.reject(new Error('no execCommand'));
            var el = document.createElement('textarea');
            el.value = text;
            el.setAttribute('readonly', '');
            el.style.position = 'fixed';
            el.style.left = '-9999px';
            document.body.appendChild(el);
            el.focus();
            el.select();
            try {
              if (document.execCommand('copy')) return Promise.resolve();
              return Promise.reject(new Error('execCommand copy returned false'));
            } catch (err) {
              return Promise.reject(err);
            } finally {
              el.remove();
            }
          };
          clipboardNav.clipboard.writeText = function (text) {
            try {
              return nativeWriteText(text).catch(function () { return execCopy(text); });
            } catch (err) {
              return execCopy(text);
            }
          };
          try { clipboardNav.clipboard.__dshClipboardFallback = true; } catch (e) { /* marker only */ }
        }
      } catch (e) { /* clipboard patch is best-effort */ }

      try {
        var styleEl = document.createElement('style');
        styleEl.textContent = '@keyframes dsh-composer-upload-spin{to{transform:rotate(360deg)}}';
        (document.head || document.documentElement).appendChild(styleEl);
      } catch (e) { /* head may be unavailable; harmless */ }

      resolveController = function (sessionId) {
        try {
          var sessions = ctx.sessions;
          if (sessions && sessionId !== undefined && sessionId !== null) {
            var scoped = sessions.scope(sessionId);
            if (scoped) {
              var c = scoped.get('conversation');
              if (c) return c;
            }
          }
          return ctx.get('conversation');
        } catch (e) { return undefined; }
      };

      ctx.slots.inject('conversation.input.left', function () {
        return ctx.slots.register(
          { name: 'conversation.input.left', id: 'dsh-composer-upload', order: 20 },
          UploadButton,
        );
      });
      ctx.slots.inject('conversation.input.right', function () {
        return ctx.slots.register(
          { name: 'conversation.input.right', id: 'dsh-composer-continue', order: 30 },
          ContinueButton,
        );
      });
    }

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
