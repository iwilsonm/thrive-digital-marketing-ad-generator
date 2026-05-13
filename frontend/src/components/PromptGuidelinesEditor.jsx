import { useContext, useEffect, useRef, useState } from 'react';
import { AuthContext } from '../App';
import { api } from '../api';
import InfoTooltip from './InfoTooltip';

export default function PromptGuidelinesEditor({
  projectId,
  initialValue = '',
  onSaved,
  className = '',
}) {
  const { user } = useContext(AuthContext);
  const canEdit = user?.role === 'admin' || user?.role === 'manager';
  const [value, setValue] = useState(initialValue || '');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const saveTimer = useRef(null);

  useEffect(() => {
    setValue(initialValue || '');
    setSaved(false);
  }, [initialValue]);

  useEffect(() => () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
  }, []);

  const handleChange = (nextValue) => {
    setValue(nextValue);
    setSaved(false);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      setSaving(true);
      try {
        await api.updateProject(projectId, { prompt_guidelines: nextValue });
        setSaved(true);
        if (typeof onSaved === 'function') onSaved(nextValue);
      } catch (err) {
        console.error('Failed to save prompt guidelines:', err);
      } finally {
        setSaving(false);
      }
    }, 1500);
  };

  return (
    <div className={className}>
      <div className="flex items-center justify-between mb-1.5">
        <label className="block text-[13px] font-medium text-ed-ink2 flex items-center gap-1">
          Prompt Guidelines
          <InfoTooltip text="Rules the AI will enforce on every generated image prompt. Use this to fix recurring issues in your ads." position="right" />
        </label>
        {canEdit && saving && (
          <span className="text-[11px] text-ed-ink3 flex items-center gap-1">
            <div className="w-2.5 h-2.5 rounded-full border border-ed-line border-t-ed-accent/60 animate-spin" />
            Saving...
          </span>
        )}
        {canEdit && !saving && saved && (
          <span className="text-[11px] text-ed-green">Saved</span>
        )}
      </div>
      <p className="text-[11px] text-ed-accent mb-2">
        Optional — only needed if you're noticing a recurring pattern in the output you'd like to correct.
      </p>
      {canEdit ? (
        <textarea
          data-testid="prompt-guidelines-input"
          value={value}
          onChange={e => handleChange(e.target.value)}
          rows={2}
          className="input-apple !border-ed-line focus:!ring-ed-accent/20 focus:!border-ed-accent resize-none text-[13px]"
          placeholder='e.g., "Only show one type of produce at a time — never mix fruits/vegetables in the same image"'
        />
      ) : (
        <div className="min-h-[68px] rounded-lg border border-ed-line bg-ed-bg px-3 py-2 text-[12px] text-ed-ink3 leading-relaxed">
          {value.trim() || 'No prompt guidelines set.'}
        </div>
      )}
      <p className="text-[11px] text-ed-ink3 mt-1">
        These rules are automatically applied to every image prompt before generation. Changes auto-save.
      </p>
    </div>
  );
}
