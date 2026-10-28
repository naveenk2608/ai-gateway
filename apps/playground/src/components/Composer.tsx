import { Send, Square } from 'lucide-react';
import { useState, type FormEvent, type KeyboardEvent } from 'react';

/** The message box: Enter sends, Shift+Enter starts a new line; Stop ends a streaming reply. */
export function Composer({
  disabled,
  busy,
  onSend,
  onStop,
}: {
  disabled: boolean;
  busy: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
}) {
  const [text, setText] = useState('');
  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (disabled || busy || text.trim() === '') return;
    onSend(text);
    setText('');
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };
  return (
    <form className="pg-composer" onSubmit={submit} aria-label="Send a message">
      <textarea
        aria-label="Message"
        placeholder={disabled ? 'Connect and pick a model first' : 'Message the model…'}
        rows={2}
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
      />
      {busy ? (
        <button type="button" className="danger" onClick={onStop}>
          <Square size={14} aria-hidden="true" />
          Stop
        </button>
      ) : (
        <button type="submit" className="primary" disabled={disabled || text.trim() === ''}>
          <Send size={14} aria-hidden="true" />
          Send
        </button>
      )}
    </form>
  );
}
