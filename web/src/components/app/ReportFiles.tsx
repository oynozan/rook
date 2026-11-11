'use client';

// The files delivered with the report, as their folder tree: each to download (by its own name) or copy, the whole set
// as one zip with its folders, a web page to preview with the delivered styles, scripts and images it uses, an SVG as
// an image, and, for a project only a computer can run (Next.js, Express), how to run it. A file's text is the agent's,
// so it is never put into this page: the preview is a sandboxed frame with scripts but no same-origin access, so it
// can't read this page, its session or the wallet, navigate this tab, or open windows. Its links ask this page to show
// another delivered page, and only that frame's messages count.
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Reveal, RowButton } from '@/components/app/controls';
import { Markdown } from '@/components/app/Markdown';
import { detail } from '@/lib/errors';
import { fileTree, isSvg, navRequest, navTarget, previewDoc, projectOf, zipName, zipPaths, type Project, type TreeNode } from '@/lib/project';
import { blobType, downloadName, isHtml, lineCount, madeBy } from '@/lib/report';
import type { ReportFile } from '@/lib/server/orchestrator';
import { zip } from '@/lib/zip';

const cause = (e: unknown) => detail(e instanceof Error ? e.message : e);

/** Saves `blob` as `name` through a download link; the browser has its own copy by the time the URL goes. */
function save(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** `name`: what the project is called, for the zip's own name. */
export function ReportFiles({ files, titles, name }: { files: ReportFile[]; titles: Map<string, string>; name?: string }) {
  const tree = useMemo(() => fileTree(files.map((f) => f.name)), [files]);
  const project = useMemo(() => projectOf(files), [files]);
  const [note, setNote] = useState<string | null>(null);

  function downloadZip() {
    try {
      const enc = new TextEncoder();
      const paths = zipPaths(files.map((f) => f.name));
      save(new Blob([zip(files.map((f, i) => ({ path: paths[i], data: enc.encode(f.text) })))], { type: 'application/zip' }), zipName(name));
      setNote(null);
    } catch (e) {
      setNote(`This browser couldn't save the zip${cause(e) ? ` (${cause(e)})` : ''}. Download the files one by one instead.`);
    }
  }

  return (
    <section className="mt-6">
      <div className="flex flex-wrap items-center justify-between gap-x-4">
        <h3 className="text-xl font-medium tracking-[-0.01em]">Files</h3>
        {files.length > 1 && <span className="-mr-3"><RowButton onClick={downloadZip}>Download project (.zip)</RowButton></span>}
      </div>
      {note && <p role="alert" className="text-sm text-alert">{note}</p>}
      {project && <RunSteps project={project} many={files.length > 1} />}
      <ul className="mt-2 rounded-2xl border border-ink/15">
        <Nodes nodes={tree} depth={0} files={files} titles={titles} project={project} />
      </ul>
    </section>
  );
}

/** A project that needs its own tools: what it is, that it can't be previewed here, and how to run it. */
function RunSteps({ project, many }: { project: Project; many: boolean }) {
  const { steps } = project;
  return (
    <div className="mt-2 rounded-2xl bg-ink/5 p-4 text-sm">
      <p>This is {project.words}. It runs on a computer with Node.js, so Rook can&apos;t preview it here.</p>
      {steps?.from === 'readme' && (
        <>
          <p className="mt-2 text-ink/65">How to run it, from its README:</p>
          <Markdown markdown={steps.markdown} className="mt-1" />
        </>
      )}
      {steps?.from === 'scripts' && (
        <>
          <p className="mt-2 text-ink/65">{many ? 'Download the project, unzip it, and in its folder run:' : 'Download it, and in its folder run:'}</p>
          <pre tabIndex={0} aria-label="Commands" className="mt-1 overflow-x-auto rounded-xl bg-surface p-3 font-mono leading-snug outline-none focus-visible:ring-2 focus-visible:ring-accent/50">
            {steps.commands.join('\n')}
          </pre>
          <p className="mt-2 text-ink/65">Then open the address it prints in your browser.</p>
        </>
      )}
      {!steps && <p className="mt-2 text-ink/65">Its files don&apos;t say how to run it: look in its README or package.json once it&apos;s downloaded.</p>}
    </div>
  );
}

const indent = (depth: number) => ({ paddingLeft: `${1 + Math.min(depth, 4) * 0.875}rem` });

function Nodes({ nodes, depth, ...rest }: { nodes: TreeNode[]; depth: number; files: ReportFile[]; titles: Map<string, string>; project: Project | null }) {
  return nodes.map((n) => n.kind === 'folder' ? (
    <li key={`d:${n.path}`} className="min-w-0 border-b border-ink/10 last:border-b-0">
      <p className="flex min-w-0 items-center gap-2 py-2 pr-4 font-mono text-sm text-ink/70" style={indent(depth)}>
        <svg className="size-4 shrink-0" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" aria-hidden="true">
          <path d="M1.75 4.25a1 1 0 0 1 1-1h3.4l1.5 1.5h5.6a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H2.75a1 1 0 0 1-1-1z" />
        </svg>
        <span className="break-all">{n.name}/</span>
      </p>
      <ul aria-label={`Folder ${n.path}`} className="border-t border-ink/10">
        <Nodes nodes={n.children} depth={depth + 1} {...rest} />
      </ul>
    </li>
  ) : (
    <FileRow key={`f:${n.index}`} file={rest.files[n.index]} label={n.name} depth={depth} files={rest.files} part={rest.titles.get(rest.files[n.index].subtask_id)} project={rest.project} />
  ));
}

function FileRow({ file, label, depth, files, part, project }: { file: ReportFile; label: string; depth: number; files: ReportFile[]; part?: string; project: Project | null }) {
  const [preview, setPreview] = useState(false);
  const [big, setBig] = useState(false);
  const [note, setNote] = useState<{ text: string; alert?: true } | null>(null);
  const frameId = useId();
  // A project only its own tools can run shows no page preview: its pages need what it builds.
  const page = isHtml(file) && !project;
  const image = isSvg(file);
  const lines = lineCount(file.text);

  function download() {
    try {
      save(new Blob([file.text], { type: blobType(file.mime) }), downloadName(file.name));
      setNote(null);
    } catch (e) {
      setNote({ text: `This browser couldn't save the file${cause(e) ? ` (${cause(e)})` : ''}. Copy it instead.`, alert: true });
    }
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(file.text);
      setNote({ text: 'Copied.' });
    } catch (e) {
      setNote({ text: `This browser didn't let the page copy it${cause(e) ? ` (${cause(e)})` : ''}. Download it instead.`, alert: true });
    }
  }

  return (
    <li className="min-w-0 border-b border-ink/10 py-3 pr-4 last:border-b-0" style={indent(depth)}>
      <p className="font-mono text-sm break-all" title={file.name !== label ? file.name : undefined}>{label}</p>
      <p className="text-sm text-ink/60">
        {lines} line{lines === 1 ? '' : 's'}
        {' · '}from {madeBy(file.agent_handle) === 'Rook' ? 'Rook' : <span className="font-mono break-all">{file.agent_handle}</span>}{part ? ` for ${part}` : ''}
      </p>
      <div className="-ml-3 mt-1 flex flex-wrap items-center">
        <RowButton onClick={download}>Download<span className="sr-only"> {file.name}</span></RowButton>
        <RowButton onClick={() => void copy()}>Copy<span className="sr-only"> {file.name}</span></RowButton>
        {(page || image) && <RowButton onClick={() => setPreview((p) => !p)} expanded={preview} controls={preview ? frameId : undefined}>Preview<span className="sr-only"> {file.name}</span></RowButton>}
        {page && preview && <RowButton onClick={() => setBig((b) => !b)} expanded={big}>{big ? 'Smaller' : 'Larger'}</RowButton>}
      </div>
      {note && <p role={note.alert ? 'alert' : 'status'} className={`text-sm ${note.alert ? 'text-alert' : 'text-ink/65'}`}>{note.text}</p>}
      {(page || image) && (
        <Reveal open={preview}>
          <div id={frameId} className="pt-2">
            {page ? <PagePreview file={file} files={files} big={big} /> : <SvgPreview file={file} />}
          </div>
        </Reveal>
      )}
    </li>
  );
}

/** A delivered web page in a sealed frame, with the delivered files it uses; its links to other delivered pages switch it. */
function PagePreview({ file, files, big }: { file: ReportFile; files: ReportFile[]; big: boolean }) {
  const [page, setPage] = useState(file.name);
  const [outside, setOutside] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const doc = useMemo(() => previewDoc(files, page) ?? file.text, [files, page, file.text]);
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      // Only this frame's own messages: any other window (another preview, a wallet's frame) is ignored.
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const href = navRequest(e.data);
      if (href === null) return;
      const to = navTarget(files, page, href);
      setOutside(!to);
      if (to) setPage(to);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [files, page]);
  return (
    <>
      {page !== file.name && (
        <p className="mb-1 flex flex-wrap items-center gap-x-2 text-sm text-ink/65">
          Showing <span className="font-mono break-all">{page}</span>
          <span className="-my-2"><RowButton onClick={() => { setPage(file.name); setOutside(false); }}>Back to {file.name.split('/').pop()}</RowButton></span>
        </p>
      )}
      {/* Never allow-same-origin (with allow-scripts the page could lift its own sandbox), top navigation or popups. */}
      <iframe
        ref={frame}
        title={`Preview of ${page}`}
        srcDoc={doc}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        className={`block w-full rounded-xl border border-ink/15 bg-white ${big ? 'h-[80vh]' : 'h-80'}`}
      />
      {outside && <p role="status" className="mt-1 text-sm text-ink/65">That link leads outside the delivered files, so the preview stays on this page.</p>}
      {/* ponytail: the frame inherits this page's content policy, so scripts the page loads from other sites don't run here. */}
      <p className="mt-1 text-xs text-ink/55">A preview in a sealed frame, with the styles, scripts and images delivered with it. Scripts it loads from other sites don&apos;t run here.</p>
    </>
  );
}

/** An SVG as an image: an <img> never runs the scripts an SVG may hold. */
function SvgPreview({ file }: { file: ReportFile }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const u = URL.createObjectURL(new Blob([file.text], { type: 'image/svg+xml' }));
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file.text]);
  return url ? (
    // eslint-disable-next-line @next/next/no-img-element -- a blob URL of the delivered file, nothing to optimise
    <img src={url} alt={`Preview of ${file.name}`} className="block max-h-80 max-w-full rounded-xl border border-ink/15 bg-white object-contain p-2" />
  ) : null;
}
