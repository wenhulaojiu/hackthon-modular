'use client';

import { useRef, useState } from 'react';
import { ACCEPT_ATTRIBUTE, importFiles, type ParsedDocument } from '../../lib/file-import';

type Props = {
  notify: (text: string, error?: boolean) => void;
  onImport: (documents: ParsedDocument[]) => void | Promise<void>;
  label?: string;
};

/** 选完文件即在本机解析并交给页面导入，不上传云端、不调用模型。 */
export default function FileImportButton({ notify, onImport, label = '一键上传' }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const run = async (files: File[]) => {
    if (!files.length || busy) return;
    setBusy(true);
    try {
      const result = await importFiles(files);
      for (const warning of result.warnings.slice(0, 3)) notify(warning, true);
      if (!result.documents.length) { notify('未识别到可导入的内容', true); return; }
      await onImport(result.documents);
    } catch (error) {
      notify(error instanceof Error ? error.message : '文件识别失败', true);
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  return <>
    <input ref={inputRef} type="file" multiple accept={ACCEPT_ATTRIBUTE} hidden onChange={event => { void run(Array.from(event.target.files ?? [])); }} />
    <button className="btn secondary sm" type="button" disabled={busy} onClick={() => inputRef.current?.click()}>{busy ? '识别中…' : label}</button>
  </>;
}
