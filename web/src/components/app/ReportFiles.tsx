'use client';

// The files agents delivered with the report (a web page, a script): named and counted, to download or copy, and a web
// page to preview. A file's text is the agent's, so it is never put into this page: the preview is a sandboxed frame
// with scripts but no same-origin access, so it can't read this page, its session or the wallet, navigate this tab,
// or open windows.
import { useId, useState } from 'react';
import { Reveal, RowButton } from '@/components/app/controls';
import { detail } from '@/lib/errors';
import { blobType, downloadName, isHtml, lineCount, madeBy } from '@/lib/report';
import type { ReportFile } from '@/lib/server/orchestrator';

export function ReportFiles({ files, titles }: { files: ReportFile[]; titles: Map<string, string> }) {
  return (
    <section className="mt-6">
      <h3 className="text-xl font-medium tracking-[-0.01em]">Files</h3>
      <ul className="mt-2 rounded-2xl border border-ink/15">
        {files.map((f, i) => <FileRow key={`${f.subtask_id}:${f.name}:${i}`} file={f} part={titles.get(f.subtask_id)} />)}
      </ul>
    </section>
  );
}

function FileRow({ file, part }: { file: ReportFile; part?: string }) {
  const [preview, setPreview] = useState(false);
  const [big, setBig] = useState(false);
  const [note, setNote] = useState<{ text: string; alert?: true } | null>(null);
  const frameId = useId();
  const html = isHtml(file);
  const lines = lineCount(file.text);
  const cause = (e: unknown) => detail(e instanceof Error ? e.message : e);

  function download() {
    try {
      const url = URL.createObjectURL(new Blob([file.text], { type: blobType(file.mime) }));
      const a = document.createElement('a');
      a.href = url;
      a.download = downloadName(file.name);
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000); // the download has its own copy by then
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
    <li className="min-w-0 border-b border-ink/10 px-4 py-3 last:border-b-0">
      <p className="font-mono text-sm break-all">{file.name}</p>
      <p className="text-sm text-ink/60">
        {lines} line{lines === 1 ? '' : 's'}
        {' · '}from {madeBy(file.agent_handle) === 'Rook' ? 'Rook' : <span className="font-mono break-all">{file.agent_handle}</span>}{part ? ` for ${part}` : ''}
      </p>
      <div className="-ml-3 mt-1 flex flex-wrap items-center">
        <RowButton onClick={download}>Download<span className="sr-only"> {file.name}</span></RowButton>
        <RowButton onClick={() => void copy()}>Copy<span className="sr-only"> {file.name}</span></RowButton>
        {html && <RowButton onClick={() => setPreview((p) => !p)} expanded={preview} controls={preview ? frameId : undefined}>Preview<span className="sr-only"> {file.name}</span></RowButton>}
        {html && preview && <RowButton onClick={() => setBig((b) => !b)} expanded={big}>{big ? 'Smaller' : 'Larger'}</RowButton>}
      </div>
      {note && <p role={note.alert ? 'alert' : 'status'} className={`text-sm ${note.alert ? 'text-alert' : 'text-ink/65'}`}>{note.text}</p>}
      {html && (
        <Reveal open={preview}>
          <div id={frameId} className="pt-2">
            {/* Never allow-same-origin (with allow-scripts the page could lift its own sandbox), top navigation or popups. */}
            <iframe
              title={`Preview of ${file.name}`}
              srcDoc={file.text}
              sandbox="allow-scripts"
              referrerPolicy="no-referrer"
              className={`block w-full rounded-xl border border-ink/15 bg-white ${big ? 'h-[80vh]' : 'h-80'}`}
            />
            {/* ponytail: the frame inherits this page's content policy, so scripts the file loads from other sites don't run here. */}
            <p className="mt-1 text-xs text-ink/55">A preview in a sealed frame. Scripts it loads from other sites don&apos;t run here: download it to see it whole.</p>
          </div>
        </Reveal>
      )}
    </li>
  );
}
