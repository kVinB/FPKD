import { useId, useState } from 'react';
import type { AffectedArea, AffectedAreas, Tag, TagAnswer, TagKind } from '@shared/types';
import { AFFECTED_AREA_LABELS } from '@shared/types';
import { codePointLength, normalizeTagLabel } from '@shared/tags';

const AREA_ORDER: AffectedArea[] = ['arms', 'legs', 'speech'];

export function AffectedAreasField({
  value,
  onChange,
}: {
  value: AffectedAreas;
  onChange: (value: AffectedAreas) => void;
}): JSX.Element {
  const selected = value.status === 'reported' ? value.areas : [];

  const toggleArea = (area: AffectedArea) => {
    if (selected.includes(area)) {
      const next = selected.filter((entry) => entry !== area);
      onChange(next.length === 0 ? { status: 'not_recorded' } : { status: 'reported', areas: next });
    } else {
      onChange({
        status: 'reported',
        areas: AREA_ORDER.filter((entry) => entry === area || selected.includes(entry)),
      });
    }
  };

  const toggleAlternative = (status: 'unknown' | 'none_reported') => {
    onChange(value.status === status ? { status: 'not_recorded' } : { status });
  };

  return (
    <fieldset id="field-affectedAreas" tabIndex={-1} className="space-y-2">
      <legend className="field-label">What was affected?</legend>
      <p className="muted">
        Choose any combination. This records what you observed, not a clinical classification.
      </p>
      <div className="flex flex-wrap gap-2">
        {AREA_ORDER.map((area) => {
          const checked = selected.includes(area);
          return (
            <label key={area} className="cursor-pointer">
              <input
                type="checkbox"
                className="peer sr-only"
                checked={checked}
                onChange={() => toggleArea(area)}
              />
              <span className="chip peer-checked:border-teal-600 peer-checked:bg-teal-50 peer-checked:text-teal-700 peer-focus-visible:ring-2 peer-focus-visible:ring-teal-600">
                {AFFECTED_AREA_LABELS[area]}
              </span>
            </label>
          );
        })}
        <button
          type="button"
          className={`chip ${value.status === 'unknown' ? 'chip-selected' : ''}`}
          aria-pressed={value.status === 'unknown'}
          onClick={() => toggleAlternative('unknown')}
        >
          Unsure
        </button>
        <button
          type="button"
          className={`chip ${value.status === 'none_reported' ? 'chip-selected' : ''}`}
          aria-pressed={value.status === 'none_reported'}
          onClick={() => toggleAlternative('none_reported')}
        >
          None of these
        </button>
      </div>
      <p className="muted">
        {value.status === 'not_recorded'
          ? 'Not recorded'
          : value.status === 'unknown'
            ? 'Recorded as Unsure'
            : value.status === 'none_reported'
              ? 'Recorded as None of these'
              : 'Recorded with the selected areas'}
      </p>
    </fieldset>
  );
}

export function TagPicker({
  id,
  legend,
  hint,
  kind,
  value,
  suggestions,
  onChange,
}: {
  id: string;
  legend: string;
  hint: string;
  kind: TagKind;
  value: TagAnswer;
  suggestions: Tag[];
  onChange: (value: TagAnswer) => void;
}): JSX.Element {
  const inputId = useId();
  const [custom, setCustom] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const selected = value.status === 'reported' ? value.tags : [];
  const selectedIds = new Set(selected.map((tag) => tag.id));
  const selectedLabels = new Set(selected.map((tag) => normalizeTagLabel(tag.label)));

  const setReported = (tags: { id: string; label: string }[]) => {
    if (tags.length === 0) {
      onChange({ status: 'not_recorded' });
      return;
    }
    onChange({ status: 'reported', tags });
  };

  const toggleSuggestion = (tag: Tag) => {
    if (selectedIds.has(tag.id) || selectedLabels.has(tag.normalizedLabel)) {
      setReported(selected.filter((entry) => entry.id !== tag.id));
    } else {
      if (selected.length >= 12) return;
      setReported([...selected, { id: tag.id, label: tag.label }]);
    }
  };

  const addCustom = () => {
    const label = custom.trim();
    if (label.length === 0) {
      setLocalError('Type a label before adding.');
      return;
    }
    if (codePointLength(label) > 40) {
      setLocalError('Tag labels must be 1–40 characters.');
      return;
    }
    const normalized = normalizeTagLabel(label);
    const existing =
      suggestions.find((tag) => tag.normalizedLabel === normalized) ??
      selected.find((tag) => normalizeTagLabel(tag.label) === normalized);
    if (existing) {
      if (!selectedLabels.has(normalized)) {
        setReported([...selected, { id: existing.id, label: existing.label }]);
      }
      setCustom('');
      setLocalError(null);
      return;
    }
    if (selected.length >= 12) {
      setLocalError('Use up to 12 tags.');
      return;
    }
    setReported([...selected, { id: crypto.randomUUID(), label }]);
    setCustom('');
    setLocalError(null);
  };

  return (
    <fieldset id={`field-${id}`} tabIndex={-1} className="space-y-2">
      <legend className="field-label">{legend}</legend>
      <p className="muted">{hint}</p>
      <div className="flex flex-wrap gap-2">
        {suggestions.slice(0, 12).map((tag) => {
          const active = selectedIds.has(tag.id) || selectedLabels.has(tag.normalizedLabel);
          return (
            <button
              key={`${kind}-${tag.id}`}
              type="button"
              className={`chip ${active ? 'chip-selected' : ''}`}
              aria-pressed={active}
              onClick={() => toggleSuggestion(tag)}
            >
              {tag.label}
            </button>
          );
        })}
        <button
          type="button"
          className={`chip ${value.status === 'unknown' ? 'chip-selected' : ''}`}
          aria-pressed={value.status === 'unknown'}
          onClick={() =>
            onChange(value.status === 'unknown' ? { status: 'not_recorded' } : { status: 'unknown' })
          }
        >
          Unsure
        </button>
        <button
          type="button"
          className={`chip ${value.status === 'none_reported' ? 'chip-selected' : ''}`}
          aria-pressed={value.status === 'none_reported'}
          onClick={() =>
            onChange(
              value.status === 'none_reported'
                ? { status: 'not_recorded' }
                : { status: 'none_reported' },
            )
          }
        >
          None reported
        </button>
      </div>

      {selected.length > 0 ? (
        <ul className="flex flex-wrap gap-2" aria-label={`Selected ${legend.toLowerCase()}`}>
          {selected.map((tag) => (
            <li key={tag.id}>
              <button
                type="button"
                className="chip chip-selected"
                onClick={() => setReported(selected.filter((entry) => entry.id !== tag.id))}
                aria-label={`Remove ${tag.label}`}
              >
                {tag.label} <span aria-hidden="true">×</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">
          {value.status === 'not_recorded'
            ? 'Not recorded'
            : value.status === 'unknown'
              ? 'Recorded as Unsure'
              : 'Recorded as None reported'}
        </p>
      )}

      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="flex-1">
          <label htmlFor={inputId} className="field-label">
            Add a custom label
          </label>
          <input
            id={inputId}
            className="field-input"
            value={custom}
            maxLength={80}
            onChange={(event) => setCustom(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                addCustom();
              }
            }}
            placeholder="Your own description"
          />
        </div>
        <button type="button" className="btn-secondary" onClick={addCustom}>
          Add
        </button>
      </div>
      {localError ? <p className="text-sm text-red-700">{localError}</p> : null}
    </fieldset>
  );
}
