import { useEffect, useRef, useState } from 'react';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { Socket } from 'socket.io-client';
import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { defaultKeymap, indentWithTab } from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { cpp } from '@codemirror/lang-cpp';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { oneDark } from '@codemirror/theme-one-dark';
import { yCollab } from 'y-codemirror.next';
import {
  PlayIcon,
  TerminalIcon,
  DownloadIcon,
  AcademicCapIcon,
} from '@heroicons/react/outline';
import { bindYDocToRoom, colorForName } from './room-yjs';
import useAuth from '../../hooks/use-auth';
import CodeService from '../../services/code-service';
import LeetcodeService, { ProblemData } from '../../services/leetcode-service';
import { buildRunnableCode, driverSupported } from './drivers';
import CodeConsole, {
  ConsoleTab,
  RunOutput,
  TestCase,
  TestResult,
} from './CodeConsole';

type Theme = 'dark' | 'light';

interface CollabCodeEditorProps {
  socket: Socket;
  me: string;
  theme: Theme;
}

const LANGUAGES: Record<string, () => any> = {
  JavaScript: () => javascript(),
  TypeScript: () => javascript({ typescript: true }),
  Python: () => python(),
  'C / C++': () => cpp(),
  HTML: () => html(),
  CSS: () => css(),
};

// Languages the backend can execute (via Piston); HTML/CSS are markup-only.
const RUNNABLE = new Set(['JavaScript', 'TypeScript', 'Python', 'C / C++']);

const uid = () => Math.random().toString(36).slice(2, 10);

const errorMessage = (err: unknown): string =>
  (err as any)?.response?.data?.errors?.[0]?.msg ??
  'Something went wrong — try again.';

// Minimal starter snippets so a fresh room isn't a blank page.
const TEMPLATES: Record<string, string> = {
  JavaScript: `// JavaScript
function greet(name) {
  return \`Hello, \${name}!\`;
}

console.log(greet("Verse"));
`,
  TypeScript: `// TypeScript
function greet(name: string): string {
  return \`Hello, \${name}!\`;
}

console.log(greet("Verse"));
`,
  Python: `# Python
def greet(name: str) -> str:
    return f"Hello, {name}!"


print(greet("Verse"))
`,
  'C / C++': `#include <iostream>

int main() {
    std::cout << "Hello, Verse!" << std::endl;
    return 0;
}
`,
  HTML: `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Verse</title>
  </head>
  <body>
    <h1>Hello, Verse!</h1>
  </body>
</html>
`,
  CSS: `/* CSS */
body {
  font-family: system-ui, sans-serif;
  color: #1a1a1a;
  background: #faf7f2;
}
`,
};

const baseTheme = EditorView.theme({
  '&': { height: '100%', fontSize: '14px' },
  '.cm-scroller': {
    fontFamily: "'JetBrains Mono', 'Fira Code', ui-monospace, monospace",
  },
  '&.cm-focused': { outline: 'none' },
});

// Dark: oneDark with a near-black background to match the session.
const darkExtension = [
  oneDark,
  EditorView.theme(
    {
      '&': { backgroundColor: '#131316' },
      '.cm-gutters': {
        backgroundColor: '#131316',
        borderRight: '1px solid rgba(255,255,255,0.06)',
        color: 'rgba(255,255,255,0.25)',
      },
      '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,0.03)' },
      '.cm-activeLineGutter': { backgroundColor: 'rgba(255,255,255,0.05)' },
    },
    { dark: true }
  ),
];

// Light: paper canvas with ink text (default highlighting from basicSetup).
const lightExtension = EditorView.theme(
  {
    '&': { backgroundColor: '#ffffff', color: '#1a1a1a' },
    '.cm-content': { caretColor: '#1a1a1a' },
    '.cm-gutters': {
      backgroundColor: '#faf7f2',
      borderRight: '1px solid #f2ece1',
      color: '#b8b2a8',
    },
    '.cm-activeLine': { backgroundColor: 'rgba(180,83,9,0.04)' },
    '.cm-activeLineGutter': { backgroundColor: 'rgba(180,83,9,0.06)' },
    '.cm-cursor, .cm-cursor-primary': {
      borderLeftColor: '#1a1a1a',
      borderLeftWidth: '2px',
    },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
      backgroundColor: 'rgba(180,83,9,0.15)',
    },
  },
  { dark: false }
);

const themeExtension = (theme: Theme) =>
  theme === 'dark' ? darkExtension : lightExtension;

const CollabCodeEditor = ({ socket, me, theme }: CollabCodeEditorProps) => {
  const dark = theme === 'dark';
  const { accessToken } = useAuth();
  const parentRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const langCompartmentRef = useRef(new Compartment());
  const themeCompartmentRef = useRef(new Compartment());
  const ytextRef = useRef<Y.Text | null>(null);
  const langRef = useRef('JavaScript');
  const [language, setLanguage] = useState('JavaScript');

  // --- Teaching mode (follow-the-host) ---
  // Spotlight state is shared room-wide via the meta map; the presenter's
  // moment-to-moment viewport rides a lightweight `room:follow` socket event.
  const [spotlight, setSpotlight] = useState<{
    hostId: string;
    hostName: string;
  } | null>(null);
  const [followOptOut, setFollowOptOut] = useState(false);
  const presentingRef = useRef(false);
  const followingRef = useRef(false);
  const scheduleEmitRef = useRef<(() => void) | null>(null);

  const mySocketId = socket.id;
  const presenting = !!spotlight && spotlight.hostId === mySocketId;
  const following =
    !!spotlight && spotlight.hostId !== mySocketId && !followOptOut;

  // --- Code execution + shared test cases ---
  const ytestsRef = useRef<Y.Array<TestCase> | null>(null);
  const ymetaRef = useRef<Y.Map<any> | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [tab, setTab] = useState<ConsoleTab>('output');
  const [running, setRunning] = useState(false);
  const [output, setOutput] = useState<RunOutput | null>(null);
  const [tests, setTests] = useState<TestCase[]>([]);
  const [testsRunning, setTestsRunning] = useState(false);
  const [testResults, setTestResults] = useState<Record<string, TestResult>>(
    {}
  );
  const runnable = RUNNABLE.has(language);

  // --- Imported LeetCode problem (shared with the room via the meta map) ---
  const problemRef = useRef<ProblemData | null>(null);
  const [problem, setProblem] = useState<ProblemData | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importValue, setImportValue] = useState('');
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  // --- Resizable console (drag the divider between editor and console) ---
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [consoleHeight, setConsoleHeight] = useState(280);
  const [consoleResizing, setConsoleResizing] = useState(false);

  const onConsoleResizeDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setConsoleResizing(true);
  };
  const onConsoleResizeMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!consoleResizing || !rootRef.current) return;
    const rect = rootRef.current.getBoundingClientRect();
    const h = rect.bottom - e.clientY;
    setConsoleHeight(Math.min(Math.max(h, 140), rect.height - 120));
  };
  const onConsoleResizeUp = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.releasePointerCapture(e.pointerId);
    setConsoleResizing(false);
  };

  // Content is still "just a starter" if it's empty or exactly matches one of
  // the known templates (built-in or the imported problem's snippets) — only
  // then may a language switch replace it. Hand-edited code is never clobbered.
  const isStarterContent = (text: string) => {
    const trimmed = text.trim();
    if (trimmed === '') return true;
    if (Object.values(TEMPLATES).some((tpl) => tpl.trim() === trimmed)) {
      return true;
    }
    const snippets = problemRef.current?.snippets;
    return snippets
      ? Object.values(snippets).some((s) => s.trim() === trimmed)
      : false;
  };

  const applyTemplate = (lang: string) => {
    const ytext = ytextRef.current;
    const doc = ytext?.doc;
    if (!ytext || !doc) return;
    // An imported problem's starter takes precedence over the built-ins.
    const template = problemRef.current?.snippets[lang] ?? TEMPLATES[lang];
    if (!template) return;
    const current = ytext.toString();
    if (!isStarterContent(current) || current === template) return;
    doc.transact(() => {
      if (ytext.length > 0) ytext.delete(0, ytext.length);
      ytext.insert(0, template);
    }, 'template');
  };

  useEffect(() => {
    if (parentRef.current === null) return;

    const ydoc = new Y.Doc();
    const ytext = ydoc.getText('codemirror');
    ytextRef.current = ytext;

    const awareness = new Awareness(ydoc);
    const color = colorForName(me);
    awareness.setLocalStateField('user', {
      name: me,
      color,
      colorLight: color + '33',
    });

    const unbind = bindYDocToRoom(socket, 'code', ydoc, awareness);

    // Shared test cases live in their own Yjs doc so everyone edits one list.
    const testsDoc = new Y.Doc();
    const ytests = testsDoc.getArray<TestCase>('tests');
    ytestsRef.current = ytests;
    const onTestsChange = () => setTests(ytests.toArray());
    ytests.observe(onTestsChange);

    // The room's language selection is shared too (same doc, separate key) —
    // when a peer switches language, everyone's editor follows. The content
    // swap itself arrives through the code doc from whoever switched.
    const ymeta = testsDoc.getMap<any>('meta');
    ymetaRef.current = ymeta;
    const onMetaChange = () => {
      const lang = ymeta.get('language') as string | undefined;
      if (lang && LANGUAGES[lang] && lang !== langRef.current) {
        setLanguage(lang);
        langRef.current = lang;
        viewRef.current?.dispatch({
          effects: langCompartmentRef.current.reconfigure(LANGUAGES[lang]()),
        });
      }
      // An imported problem is shared room-wide: show it to everyone.
      const p = ymeta.get('problem') as ProblemData | undefined;
      if (p && p.slug !== problemRef.current?.slug) {
        problemRef.current = p;
        setProblem(p);
        setPanelOpen(true);
        setTab('problem');
      }
      // Teaching mode: who (if anyone) is presenting to the room.
      const sp = ymeta.get('spotlight') as
        | { active: boolean; hostId: string; hostName: string }
        | undefined;
      setSpotlight(
        sp && sp.active ? { hostId: sp.hostId, hostName: sp.hostName } : null
      );
    };
    ymeta.observe(onMetaChange);

    const unbindTests = bindYDocToRoom(socket, 'tests', testsDoc);

    // Run results are broadcast so the whole room sees the same console.
    const onCodeResult = (payload: {
      kind: 'run' | 'tests';
      output?: RunOutput;
      results?: TestResult[];
    }) => {
      if (payload?.kind === 'run' && payload.output) {
        setOutput(payload.output);
        setRunning(false);
        setPanelOpen(true);
        setTab('output');
      } else if (payload?.kind === 'tests' && payload.results) {
        setTestResults(
          Object.fromEntries(payload.results.map((r) => [r.id, r]))
        );
        setPanelOpen(true);
        setTab('tests');
      }
    };
    socket.on('code:result', onCodeResult);

    let templated = false;
    const onCodeSync = ({ docKey }: { docKey: string }) => {
      if (docKey !== 'code' || templated) return;
      templated = true;
      // Template only a truly fresh room. An existing room already has
      // content (possibly another language's starter) — leave it alone.
      if ((ytextRef.current?.toString().trim() ?? '') === '') {
        applyTemplate(langRef.current);
      }
    };
    socket.on('room:sync', onCodeSync);

    // --- Teaching mode wiring ---
    // Presenter broadcasts the char offset at the top of their viewport (plus
    // caret); followers scroll that same position to the top. Position-based
    // (not pixel-based) so it survives each client's own pane width / wrapping.
    const emitFollow = () => {
      const v = viewRef.current;
      if (!v || !presentingRef.current) return;
      let topPos = 0;
      try {
        topPos = v.lineBlockAtHeight(v.scrollDOM.scrollTop).from;
      } catch {
        topPos = v.state.selection.main.head;
      }
      socket.emit('room:follow', { topPos, head: v.state.selection.main.head });
    };

    let emitTimer: ReturnType<typeof setTimeout> | null = null;
    let lastEmit = 0;
    const scheduleEmit = () => {
      if (!presentingRef.current) return;
      const wait = 80 - (Date.now() - lastEmit);
      if (wait <= 0) {
        lastEmit = Date.now();
        emitFollow();
      } else {
        if (emitTimer) clearTimeout(emitTimer);
        emitTimer = setTimeout(() => {
          lastEmit = Date.now();
          emitFollow();
        }, wait);
      }
    };
    scheduleEmitRef.current = scheduleEmit;

    const onFollow = (payload: { topPos?: number; head?: number }) => {
      if (!followingRef.current) return;
      const v = viewRef.current;
      if (!v) return;
      const pos = Math.min(Math.max(0, payload?.topPos ?? 0), v.state.doc.length);
      try {
        v.dispatch({
          effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: 30 }),
        });
      } catch {
        /* docs momentarily out of sync — ignore this frame */
      }
    };
    socket.on('room:follow', onFollow);

    // If the presenter disconnects, clear the (now stale) spotlight.
    const onPeerLeftClearSpotlight = ({ id }: { id: string }) => {
      const sp = ymetaRef.current?.get('spotlight') as
        | { active: boolean; hostId: string }
        | undefined;
      if (sp?.active && sp.hostId === id) ymetaRef.current?.delete('spotlight');
    };
    socket.on('room:peer-left', onPeerLeftClearSpotlight);

    const state = EditorState.create({
      doc: ytext.toString(),
      extensions: [
        basicSetup,
        keymap.of([...defaultKeymap, indentWithTab]),
        langCompartmentRef.current.of(LANGUAGES[language]()),
        baseTheme,
        themeCompartmentRef.current.of(themeExtension(theme)),
        yCollab(ytext, awareness),
        EditorView.updateListener.of((update) => {
          if (!presentingRef.current) return;
          if (
            update.selectionSet ||
            update.docChanged ||
            update.viewportChanged
          ) {
            scheduleEmit();
          }
        }),
      ],
    });

    const view = new EditorView({ state, parent: parentRef.current });
    viewRef.current = view;

    // Scrolling doesn't always change the CM viewport range, so track it too.
    const onScroll = () => scheduleEmit();
    view.scrollDOM.addEventListener('scroll', onScroll);

    return () => {
      socket.off('room:sync', onCodeSync);
      socket.off('code:result', onCodeResult);
      socket.off('room:follow', onFollow);
      socket.off('room:peer-left', onPeerLeftClearSpotlight);
      view.scrollDOM.removeEventListener('scroll', onScroll);
      if (emitTimer) clearTimeout(emitTimer);
      scheduleEmitRef.current = null;
      // Don't leave a dangling spotlight pointing at us after we leave.
      if ((ymeta.get('spotlight') as any)?.hostId === socket.id) {
        ymeta.delete('spotlight');
      }
      ytests.unobserve(onTestsChange);
      ymeta.unobserve(onMetaChange);
      ymetaRef.current = null;
      view.destroy();
      viewRef.current = null;
      unbind();
      unbindTests();
      ytestsRef.current = null;
      testsDoc.destroy();
      awareness.destroy();
      ydoc.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, me]);

  // Live-switch the editor theme.
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: themeCompartmentRef.current.reconfigure(themeExtension(theme)),
    });
  }, [theme]);

  // Keep the listeners' role flags current without re-running the main effect.
  useEffect(() => {
    presentingRef.current = presenting;
    followingRef.current = following;
  }, [presenting, following]);

  // A new presenter takes over → start following them afresh.
  useEffect(() => {
    setFollowOptOut(false);
  }, [spotlight?.hostId]);

  const startTeaching = () => {
    ymetaRef.current?.set('spotlight', {
      active: true,
      hostId: socket.id,
      hostName: me,
    });
    setFollowOptOut(false);
    // Push an initial viewport once the role flag has settled.
    setTimeout(() => scheduleEmitRef.current?.(), 60);
  };
  const stopTeaching = () => ymetaRef.current?.delete('spotlight');

  const handleLanguageChange = (value: string) => {
    setLanguage(value);
    langRef.current = value;
    viewRef.current?.dispatch({
      effects: langCompartmentRef.current.reconfigure(LANGUAGES[value]()),
    });
    applyTemplate(value);
    ymetaRef.current?.set('language', value);
  };

  // --- Execution ---

  // For imported problems, append the auto-driver that reads the test input,
  // calls the Solution method, and prints the returned value — bridging
  // LeetCode's return-based starters and our stdout-based judging.
  const runnableCode = () =>
    buildRunnableCode(
      ytextRef.current?.toString() ?? '',
      langRef.current,
      problemRef.current
    );

  const runCode = async (stdin?: string) => {
    if (!runnable || running || !accessToken) return;
    setPanelOpen(true);
    setTab('output');
    setRunning(true);
    const result: RunOutput = { by: me, language };
    try {
      const res = await CodeService.execute(accessToken, {
        language,
        code: runnableCode(),
        ...(stdin !== undefined ? { stdin } : {}),
      });
      Object.assign(result, res.data);
    } catch (err) {
      result.error = errorMessage(err);
    }
    setOutput(result);
    setRunning(false);
    socket.emit('code:result', { kind: 'run', output: result });
  };

  // Run = execute the code once (fed the first test's input, so imported
  // problems show a meaningful result) and then run the whole test list.
  const handleRun = async () => {
    if (!runnable || running || testsRunning) return;
    const first = ytestsRef.current?.length
      ? ytestsRef.current.get(0)
      : undefined;
    await runCode(first?.input);
    if (ytestsRef.current?.length) {
      // Respect the server's per-user cooldown between the two phases.
      await new Promise((resolve) => setTimeout(resolve, 650));
      await runTests();
    }
  };

  const normalize = (s: string) => s.replace(/\r\n/g, '\n').trim();

  const runTests = async () => {
    const list = ytestsRef.current?.toArray() ?? [];
    if (!runnable || testsRunning || !accessToken || list.length === 0) return;
    setPanelOpen(true);
    setTab('tests');
    setTestsRunning(true);
    const code = runnableCode();
    const results: Record<string, TestResult> = {};
    list.forEach((tc) => {
      results[tc.id] = { id: tc.id, status: 'running' };
    });
    setTestResults({ ...results });

    for (const tc of list) {
      try {
        const res = await CodeService.execute(accessToken, {
          language,
          code,
          stdin: tc.input,
        });
        const d = res.data;
        if (d.exitCode !== 0) {
          results[tc.id] = {
            id: tc.id,
            status: 'error',
            actual: (d.compileOutput || d.stderr || 'Runtime error').trim(),
          };
        } else {
          results[tc.id] = {
            id: tc.id,
            status:
              normalize(d.stdout ?? '') === normalize(tc.expected)
                ? 'pass'
                : 'fail',
            actual: (d.stdout ?? '').trim(),
          };
        }
      } catch (err) {
        results[tc.id] = { id: tc.id, status: 'error', actual: errorMessage(err) };
      }
      setTestResults({ ...results });
      // Space out requests: the server enforces a per-user cooldown.
      await new Promise((resolve) => setTimeout(resolve, 650));
    }

    setTestsRunning(false);
    socket.emit('code:result', { kind: 'tests', results: Object.values(results) });
  };

  // --- LeetCode problem import ---

  const importProblem = async () => {
    const value = importValue.trim();
    if (!value || importing || !accessToken) return;
    setImporting(true);
    setImportError(null);
    try {
      const res = await LeetcodeService.get(accessToken, value);
      const p = res.data;

      // Keep the current language if the problem has a starter for it,
      // otherwise fall back to the first common one that does.
      const preference = [
        langRef.current,
        'JavaScript',
        'Python',
        'C / C++',
        'TypeScript',
      ];
      const lang = preference.find((l) => p.snippets[l]) ?? langRef.current;
      if (lang !== langRef.current) {
        setLanguage(lang);
        langRef.current = lang;
        viewRef.current?.dispatch({
          effects: langCompartmentRef.current.reconfigure(LANGUAGES[lang]()),
        });
        ymetaRef.current?.set('language', lang);
      }

      // Share the problem with the room (the meta observer opens the panel).
      ymetaRef.current?.set('problem', p);

      // Importing is explicit — the starter replaces the editor content.
      const ytext = ytextRef.current;
      const ydoc = ytext?.doc;
      const snippet = p.snippets[lang];
      if (ytext && ydoc && snippet) {
        ydoc.transact(() => {
          if (ytext.length > 0) ytext.delete(0, ytext.length);
          ytext.insert(0, snippet);
        }, 'template');
      }

      // The example cases replace the shared test list.
      const ytests = ytestsRef.current;
      if (ytests) {
        ytests.doc?.transact(() => {
          if (ytests.length > 0) ytests.delete(0, ytests.length);
          ytests.insert(
            0,
            p.examples.map((ex) => ({
              id: uid(),
              input: ex.input,
              expected: ex.expected,
            }))
          );
        });
      }
      setTestResults({});
      setOutput(null);
      setImportOpen(false);
      setImportValue('');
    } catch (err) {
      setImportError(errorMessage(err));
    }
    setImporting(false);
  };

  // --- Shared test-case CRUD (mutate the Yjs array so peers stay in sync) ---

  const addTest = () =>
    ytestsRef.current?.push([{ id: uid(), input: '', expected: '' }]);

  const updateTest = (index: number, patch: Partial<TestCase>) => {
    const ytests = ytestsRef.current;
    const doc = ytests?.doc;
    if (!ytests || !doc || index >= ytests.length) return;
    const current = ytests.get(index);
    doc.transact(() => {
      ytests.delete(index, 1);
      ytests.insert(index, [{ ...current, ...patch }]);
    });
  };

  const removeTest = (index: number) => {
    const ytests = ytestsRef.current;
    if (!ytests || index >= ytests.length) return;
    ytests.delete(index, 1);
  };

  return (
    <div
      ref={rootRef}
      className={`flex flex-col h-full ${dark ? 'bg-[#131316]' : 'bg-white'}`}
    >
      {spotlight && !presenting && (
        <div className="flex items-center justify-between gap-2 px-4 py-1.5 text-xs bg-accent/10 border-b border-accent/30 text-accent flex-shrink-0">
          <span className="flex items-center gap-1.5 min-w-0">
            <AcademicCapIcon className="w-4 h-4 flex-shrink-0" />
            <span className="truncate">
              <strong>{spotlight.hostName}</strong>
              {following
                ? ' is presenting — following their view'
                : ' is presenting — following paused'}
            </span>
          </span>
          <button
            onClick={() => setFollowOptOut((v) => !v)}
            className="flex-shrink-0 font-semibold hover:underline"
          >
            {following ? 'Stop following' : 'Follow'}
          </button>
        </div>
      )}
      {presenting && (
        <div className="flex items-center justify-between gap-2 px-4 py-1.5 text-xs bg-accent text-white flex-shrink-0">
          <span className="flex items-center gap-1.5">
            <AcademicCapIcon className="w-4 h-4" />
            You're presenting — everyone follows your view
          </span>
          <button onClick={stopTeaching} className="font-semibold hover:underline">
            Stop teaching
          </button>
        </div>
      )}
      <div
        className={`flex items-center justify-between px-4 py-2 border-b flex-shrink-0 ${
          dark ? 'bg-[#0f0f0f] border-white/10' : 'bg-paper border-paper-2'
        }`}
      >
        <span
          className={`text-xs font-semibold uppercase tracking-wide ${
            dark ? 'text-white/50' : 'text-ink-soft'
          }`}
        >
          Code
        </span>
        <div className="flex items-center gap-2">
          {/* Import a LeetCode problem */}
          <div className="relative">
            <button
              onClick={() => {
                setImportOpen((v) => !v);
                setImportError(null);
              }}
              title="Import a LeetCode problem"
              className={`flex items-center gap-1 text-xs font-medium border rounded-md px-2 py-1 transition-colors ${
                dark
                  ? 'bg-[#1c1c1f] text-white/70 border-white/10 hover:bg-white/10'
                  : 'bg-white text-ink-soft border-paper-2 hover:bg-paper-2'
              }`}
            >
              <DownloadIcon className="w-3.5 h-3.5" />
              Import
            </button>
            {importOpen && (
              <div
                className={`absolute right-0 top-full mt-2 w-72 border rounded-xl shadow-2xl z-40 p-3 ${
                  dark
                    ? 'bg-[#1c1c1c] border-white/10 text-white'
                    : 'bg-white border-paper-2 text-ink'
                }`}
              >
                <p
                  className={`text-xs mb-2 ${
                    dark ? 'text-white/50' : 'text-ink-soft'
                  }`}
                >
                  Paste a LeetCode problem URL or slug — the statement, starter
                  code, and example test cases are shared with the room.
                </p>
                <input
                  autoFocus
                  value={importValue}
                  onChange={(e) => setImportValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') importProblem();
                    if (e.key === 'Escape') setImportOpen(false);
                  }}
                  placeholder="https://leetcode.com/problems/two-sum/"
                  spellCheck={false}
                  className={`w-full text-xs font-mono border rounded-md px-2 py-1.5 focus:outline-none focus:border-accent ${
                    dark
                      ? 'bg-[#131316] text-white/80 border-white/10 placeholder-white/25'
                      : 'bg-white text-ink border-paper-2 placeholder-ink-faint/60'
                  }`}
                />
                {importError && (
                  <p className="text-[11px] text-red-500 mt-1.5">{importError}</p>
                )}
                <div className="flex items-center justify-end gap-2 mt-2.5">
                  <button
                    onClick={() => setImportOpen(false)}
                    className={`text-xs px-2 py-1 rounded-md transition-colors ${
                      dark
                        ? 'text-white/60 hover:bg-white/10'
                        : 'text-ink-soft hover:bg-paper-2'
                    }`}
                  >
                    Cancel
                  </button>
                  <button
                    onClick={importProblem}
                    disabled={importing || !importValue.trim()}
                    className="flex items-center gap-1.5 text-xs font-semibold text-white bg-accent hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed rounded-md px-2.5 py-1 transition-colors"
                  >
                    {importing && (
                      <span className="w-3 h-3 inline-block rounded-full border-2 border-current border-t-transparent animate-spin" />
                    )}
                    Import
                  </button>
                </div>
              </div>
            )}
          </div>

          <select
            value={language}
            onChange={(e) => handleLanguageChange(e.target.value)}
            className={`text-xs rounded-md px-2 py-1 border focus:outline-none ${
              dark
                ? 'bg-[#1c1c1f] text-white/80 border-white/10'
                : 'bg-white text-ink border-paper-2'
            }`}
          >
            {Object.keys(LANGUAGES).map((lang) => (
              <option key={lang} value={lang}>
                {lang}
              </option>
            ))}
          </select>
          <button
            onClick={presenting ? stopTeaching : startTeaching}
            title={
              presenting
                ? 'Stop presenting'
                : 'Teach — everyone in the room follows your view'
            }
            className={`flex items-center gap-1 text-xs font-medium border rounded-md px-2 py-1 transition-colors ${
              presenting
                ? 'bg-accent text-white border-accent hover:bg-accent-hover'
                : dark
                ? 'bg-[#1c1c1f] text-white/70 border-white/10 hover:bg-white/10'
                : 'bg-white text-ink-soft border-paper-2 hover:bg-paper-2'
            }`}
          >
            <AcademicCapIcon className="w-3.5 h-3.5" />
            {presenting ? 'Teaching' : 'Teach'}
          </button>
          <button
            onClick={() => setPanelOpen((v) => !v)}
            title={panelOpen ? 'Hide console' : 'Show console'}
            className={`p-1.5 rounded-md transition-colors ${
              dark
                ? 'text-white/60 hover:bg-white/10'
                : 'text-ink-soft hover:bg-paper-2'
            } ${panelOpen ? (dark ? 'bg-white/10' : 'bg-paper-2') : ''}`}
          >
            <TerminalIcon className="w-4 h-4" />
          </button>
          <button
            onClick={handleRun}
            disabled={!runnable || running || testsRunning}
            title={
              runnable
                ? 'Run the code and all test cases (everyone sees the results)'
                : `${language} cannot be executed`
            }
            className="flex items-center gap-1 text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed rounded-md pl-2 pr-2.5 py-1 transition-colors"
          >
            {running || testsRunning ? (
              <span className="w-3 h-3 inline-block rounded-full border-2 border-current border-t-transparent animate-spin" />
            ) : (
              <PlayIcon className="w-3.5 h-3.5" />
            )}
            Run
          </button>
        </div>
      </div>
      <div
        ref={parentRef}
        className={`flex-1 overflow-hidden ${
          consoleResizing ? 'pointer-events-none' : ''
        }`}
      />
      {panelOpen && (
        <>
          {/* Drag to resize the console */}
          <div
            role="separator"
            aria-orientation="horizontal"
            title="Drag to resize the console"
            onPointerDown={onConsoleResizeDown}
            onPointerMove={onConsoleResizeMove}
            onPointerUp={onConsoleResizeUp}
            className={`h-1.5 flex-shrink-0 cursor-row-resize group flex items-center justify-center border-y transition-colors z-10 ${
              dark ? 'border-white/10' : 'border-paper-2'
            } ${
              consoleResizing
                ? 'bg-accent/40'
                : dark
                ? 'bg-[#0f0f0f] hover:bg-white/10'
                : 'bg-paper hover:bg-paper-2'
            }`}
          >
            <div
              className={`flex gap-1 pointer-events-none ${
                consoleResizing
                  ? 'opacity-100'
                  : 'opacity-40 group-hover:opacity-100'
              }`}
            >
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  className={`w-1 h-1 rounded-full ${
                    dark ? 'bg-white/60' : 'bg-ink-faint'
                  }`}
                />
              ))}
            </div>
          </div>
          <div
            style={{ height: consoleHeight }}
            className="flex-shrink-0 min-h-0 flex flex-col"
          >
            <CodeConsole
              theme={theme}
              tab={tab}
              setTab={setTab}
              running={running}
              output={output}
              tests={tests}
              testResults={testResults}
              testsRunning={testsRunning}
              runnable={runnable}
              problem={problem}
              driverNote={
                problem && problem.functionName
                  ? driverSupported(language)
                    ? `Runs auto-attach a driver that feeds each test's input to ${problem.functionName}() and prints the returned value.`
                    : 'No auto-driver for C/C++ — write a main() that reads stdin and prints the result.'
                  : null
              }
              onRunTests={runTests}
              onAddTest={addTest}
              onUpdateTest={updateTest}
              onRemoveTest={removeTest}
              onClose={() => setPanelOpen(false)}
            />
          </div>
        </>
      )}
    </div>
  );
};

export default CollabCodeEditor;
