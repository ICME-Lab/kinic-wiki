// Baseline: existing default Wiki editor and React root, without Vault imports or behavior.
import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { MarkdownEditor } from '@kinic/vault-ui/editor';
import '../src/style.css';
function Baseline() {
  const [content, setContent] = useState('# Synthetic baseline\n\nExisting Wiki Markdown editor');
  return <div className="h-80"><MarkdownEditor content={content} disabled={false} lineCount={3} byteCount={content.length} saveState="dirty" error={null} warning={null} onChange={setContent} onRevert={() => setContent('')} onSave={() => {}} /></div>;
}
createRoot(document.getElementById('root')!).render(<Baseline />);
