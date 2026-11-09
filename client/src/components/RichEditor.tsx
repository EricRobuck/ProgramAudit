import { useEditor, EditorContent, useEditorState, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { useEffect } from 'react';

/** Narrative editor limited to paragraphs, bold, italic and lists (matches the server's allowed HTML). */
export function RichEditor({
  initialHtml,
  editable,
  onChange,
  labelledBy,
  describedBy,
  onReady,
}: {
  initialHtml: string;
  editable: boolean;
  onChange: (html: string, text: string) => void;
  labelledBy: string;
  describedBy?: string;
  onReady?: (editor: Editor) => void;
}) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false,
        code: false,
        codeBlock: false,
        blockquote: false,
        horizontalRule: false,
        strike: false,
        link: false,
        underline: false,
      }),
    ],
    content: initialHtml || '',
    editable,
    editorProps: {
      attributes: {
        class: 'rich-content',
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-labelledby': labelledBy,
        ...(describedBy ? { 'aria-describedby': describedBy } : {}),
      },
    },
    onUpdate: ({ editor }) => onChange(editor.getHTML(), editor.getText()),
  });

  useEffect(() => {
    if (editor) {
      editor.setEditable(editable);
      editor.view.dom.setAttribute('aria-readonly', String(!editable));
    }
  }, [editor, editable]);

  useEffect(() => {
    if (editor && onReady) onReady(editor);
  }, [editor, onReady]);

  const state = useEditorState({
    editor,
    selector: ({ editor: e }) =>
      e
        ? {
            bold: e.isActive('bold'),
            italic: e.isActive('italic'),
            bullet: e.isActive('bulletList'),
            ordered: e.isActive('orderedList'),
            canUndo: e.can().undo(),
            canRedo: e.can().redo(),
          }
        : null,
  });

  if (!editor) return null;
  const btn = (label: string, text: string, active: boolean | undefined, run: () => void, disabled = false) => (
    <button
      type="button"
      className={`tool${active ? ' is-active' : ''}`}
      aria-pressed={active === undefined ? undefined : active}
      aria-label={label}
      title={label}
      disabled={!editable || disabled}
      onClick={() => run()}
    >
      {text}
    </button>
  );
  return (
    <div className={`rich-editor${editable ? '' : ' is-readonly'}`}>
      {editable && (
        <div className="toolbar" role="toolbar" aria-label="Formatting">
          {btn('Bold (Ctrl+B)', 'B', state?.bold, () => editor.chain().focus().toggleBold().run())}
          {btn('Italic (Ctrl+I)', 'I', state?.italic, () => editor.chain().focus().toggleItalic().run())}
          {btn('Bulleted list', '• List', state?.bullet, () => editor.chain().focus().toggleBulletList().run())}
          {btn('Numbered list', '1. List', state?.ordered, () => editor.chain().focus().toggleOrderedList().run())}
          <span className="toolbar-sep" />
          {btn('Undo (Ctrl+Z)', '↶', undefined, () => editor.chain().focus().undo().run(), !state?.canUndo)}
          {btn('Redo (Ctrl+Y)', '↷', undefined, () => editor.chain().focus().redo().run(), !state?.canRedo)}
        </div>
      )}
      <EditorContent editor={editor} />
    </div>
  );
}

export function hasVisibleText(text: string) {
  return text.replace(/[\s ​-‍⁠﻿]/g, '').length > 0;
}

export function countWords(text: string) {
  return text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)?.length ?? 0;
}
