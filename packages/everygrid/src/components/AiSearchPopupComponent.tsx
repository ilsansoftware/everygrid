import {useEffect, useRef, useState} from 'react';
import {I18n} from '../i18n/I18n';
import type {AiSearchOffer} from '../core/types';
import {SparkleIcon} from '../icons/SparkleIcon';
import {PopupComponent} from './PopupComponent';

/** Gradient shared by the toolbar's AI search button and the dialog's search button. */
export const AI_GRADIENT = 'bg-linear-to-r from-[#7950f3] via-[#a661d8] to-[#ce679b] text-white';
/** Pill with a white rim, lifted off a white surface by a faint outline — both AI buttons wear it. */
export const AI_FRAME = 'rounded-full border border-white shadow-[0_0_0_1px_rgba(15,23,42,0.08),0_1px_2px_rgba(15,23,42,0.12)]';

interface AiSearchPopupProps {
  offer: AiSearchOffer;
  /** The question last asked on this grid, so reopening the dialog lets the reader refine it. */
  initialQuestion: string;
  onClose: (question: string) => void;
  /** Runs the query the model wrote, through the grid's normal search. */
  onQuery: (query: string, question: string) => void;
}

/**
 * The "AI search" dialog: example chips, a question box, Cancel / Search. Search sends the question
 * to the registered handler; the query it resolves with goes into the search box and runs. Closing
 * or cancelling aborts a request still in flight.
 */
export const AiSearchPopupComponent = ({offer, initialQuestion, onClose, onQuery}: AiSearchPopupProps) => {
  const [question, setQuestion] = useState(initialQuestion);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState(offer.recent);
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);

  useEffect(() => {
    const el = inputRef.current;
    if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
    return () => abortRef.current?.abort();
  }, []);

  const close = () => {
    abortRef.current?.abort();
    onClose(question);
  };

  const search = async (text = question) => {
    const q = text.trim();
    if (!q || busy) { return; }
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setBusy(true);
    setError(null);
    try {
      const query = await offer.run(q, ctrl.signal);
      if (ctrl.signal.aborted) { return; }
      if (!query) { setError(I18n.t('popup.aiSearchEmpty')); return; }
      offer.remember(q);
      onQuery(query, q);
    } catch (e) {
      if (ctrl.signal.aborted) { return; }
      setError(I18n.t('popup.aiSearchFailed', {message: e instanceof Error ? e.message : String(e)}));
    } finally {
      if (abortRef.current === ctrl) { abortRef.current = null; }
      if (!ctrl.signal.aborted) { setBusy(false); }
    }
  };

  const chip = (text: string, onRemove?: () => void) => (
    <span key={text} className='inline-flex items-center rounded-full border border-line bg-white text-xs text-slate-700 hover:border-indigo-300'>
      <button type='button' disabled={busy}
              className={`inline-flex items-center gap-1.5 py-1 ${onRemove ? 'pl-3 pr-1' : 'px-3'} rounded-full hover:text-slate-900 disabled:opacity-50`}
              onClick={() => { setQuestion(text); void search(text); }}>
        <SparkleIcon className='w-3 h-3 text-indigo-500 shrink-0'/>
        {text}
      </button>
      {onRemove && (
        <button type='button' disabled={busy} onClick={onRemove}
                aria-label={I18n.t('popup.aiSearchForget', {question: text})}
                title={I18n.t('popup.aiSearchForget', {question: text})}
                className='px-2 py-1 leading-none text-slate-400 hover:text-red-500 disabled:opacity-50'>×</button>
      )}
    </span>
  );

  return (
    <PopupComponent onClose={close} title={I18n.t('popup.aiSearchTitle')} size='auto'>
      <div className='everygrid-ai-search flex flex-col gap-3'>
        {offer.examples.length > 0 && (
          <div className='flex flex-col gap-2'>
            <span className='text-xs font-semibold text-slate-600'>{I18n.t('popup.aiSearchExamples')}</span>
            <div className='flex flex-wrap gap-2'>{offer.examples.map(ex => chip(ex))}</div>
          </div>
        )}
        {recent.length > 0 && (
          <div className='flex flex-col gap-2'>
            <span className='text-xs font-semibold text-slate-600'>{I18n.t('popup.aiSearchRecent')}</span>
            <div className='flex flex-wrap gap-2'>
              {recent.map(q => chip(q, () => { offer.forget(q); setRecent(list => list.filter(x => x !== q)); }))}
            </div>
          </div>
        )}
        <textarea
          ref={inputRef}
          rows={4}
          value={question}
          disabled={busy}
          aria-label={I18n.t('popup.aiSearchTitle')}
          placeholder={I18n.t('popup.aiSearchPlaceholder')}
          onChange={e => { setQuestion(e.target.value); setError(null); }}
          onCompositionStart={() => { composingRef.current = true; }}
          onCompositionEnd={() => { composingRef.current = false; }}
          onKeyDown={e => {
            if (e.key === 'Escape') { e.preventDefault(); close(); return; }
            // Enter asks, Shift+Enter breaks the line — the same keys as the search box. Not while an
            // IME is composing: that Enter only commits the Hangul / kana being typed.
            if (e.key === 'Enter' && !e.shiftKey && !composingRef.current && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void search();
            }
          }}
          className='w-full px-3 py-2 text-sm leading-relaxed text-slate-700 bg-white border border-line rounded resize-y focus:outline-none focus:border-indigo-400 disabled:bg-slate-50'
        />
        {error && <div role='alert' className='text-xs text-red-500'>{error}</div>}
      </div>
      <div className='everygrid-popup-footer everygrid-ai-search'>
        <button type='button' onClick={close}
                className='px-4 py-2 font-medium text-sm bg-white text-slate-700 hover:bg-slate-50 border border-line rounded transition-colors'>
          {I18n.t('popup.cancel')}
        </button>
        {/* Icon only: the sparkle says what it does, the label goes to screen readers and the tooltip. */}
        <button type='button' disabled={busy || !question.trim()} onClick={() => void search()}
                aria-label={busy ? I18n.t('popup.aiSearchRunning') : I18n.t('popup.aiSearchRun')}
                title={busy ? I18n.t('popup.aiSearchRunning') : I18n.t('popup.aiSearchRun')}
                className={`inline-flex items-center justify-center px-5 py-2 transition-opacity hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed ${AI_FRAME} ${AI_GRADIENT}`}>
          {busy
            ? <span aria-hidden className='w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin'/>
            : <SparkleIcon className='w-4 h-4'/>}
        </button>
      </div>
    </PopupComponent>
  );
};
