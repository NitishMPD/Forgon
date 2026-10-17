import { useEffect, useState, type KeyboardEvent } from 'react';
import type { SceneConflict, SceneCommand } from '@forgon/editor-core';
import { createId, type Component, type Entity, type JsonValue, type SceneDocument, type Transform } from '@forgon/project-schema';
import { ConflictCard } from '../../conflict/ConflictCard.js';
import { formatNumber, parseFiniteNumber } from '../../model/numbers.js';
import { parseJsonDraft, propertyKind, withProperty } from '../../model/properties.js';
import type { Selection } from '../../model/selection.js';
import { Banner, Button, EmptyState, Field, cx } from '../../primitives/primitives.js';

export interface InspectorProps {
  scene: SceneDocument;
  selection: Selection;
  sourcePath: string | null;
  readOnlyReason: string | null;
  conflict: SceneConflict | null;
  onCommand(command: SceneCommand): boolean;
  onResolveConflict(choice: 'ours' | 'theirs'): void;
  onAddToAgent: ((entityId: string, name: string) => void) | null;
}

type Vector = Transform['position'];

function NumberInput({ id, label, value, disabled, onCommit }: {
  id: string;
  label: string;
  value: number;
  disabled: boolean;
  onCommit(next: number): boolean;
}) {
  const [draft, setDraft] = useState(formatNumber(value));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setDraft(formatNumber(value));
    setError(null);
  }, [value]);
  const commit = (): void => {
    const next = parseFiniteNumber(draft);
    if (next === null) {
      setError('Enter a finite number.');
      return;
    }
    if (next === value) {
      setError(null);
      return;
    }
    setError(onCommit(next) ? null : 'Change rejected. See Console.');
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') commit();
    if (event.key === 'Escape') {
      setDraft(formatNumber(value));
      setError(null);
    }
  };
  return (
    <Field label={label} htmlFor={id} error={error}>
      <input
        id={id}
        className={cx('fg-input fg-input-number', error && 'is-invalid')}
        inputMode="decimal"
        value={draft}
        disabled={disabled}
        onChange={event => setDraft(event.currentTarget.value)}
        onBlur={commit}
        onKeyDown={onKeyDown}
      />
    </Field>
  );
}

function VectorRow({ title, idPrefix, vector, disabled, onCommit }: {
  title: string;
  idPrefix: string;
  vector: Vector;
  disabled: boolean;
  onCommit(next: Vector): boolean;
}) {
  const axes = ['X', 'Y', 'Z'] as const;
  return (
    <fieldset className="fg-vector" disabled={disabled}>
      <legend className="fg-vector-title">{title}</legend>
      <div className="fg-vector-grid">
        {axes.map((axis, index) => (
          <NumberInput
            key={axis}
            id={`${idPrefix}-${axis.toLowerCase()}`}
            label={axis}
            value={vector[index] ?? 0}
            disabled={disabled}
            onCommit={next => {
              const copy: Vector = [...vector];
              copy[index] = next;
              return onCommit(copy);
            }}
          />
        ))}
      </div>
    </fieldset>
  );
}

function NameField({ entity, disabled, onCommit }: { entity: Entity; disabled: boolean; onCommit(name: string): boolean }) {
  const [draft, setDraft] = useState(entity.name);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setDraft(entity.name);
    setError(null);
  }, [entity.id, entity.name]);
  const commit = (): void => {
    const next = draft.trim();
    if (next === '') {
      setError('Name is required.');
      return;
    }
    if (next === entity.name) return;
    setError(onCommit(next) ? null : 'Change rejected. See Console.');
  };
  return (
    <Field label="Name" htmlFor="inspector-name" error={error}>
      <input
        id="inspector-name"
        className={cx('fg-input', error && 'is-invalid')}
        value={draft}
        disabled={disabled}
        onChange={event => setDraft(event.currentTarget.value)}
        onBlur={commit}
        onKeyDown={event => {
          if (event.key === 'Enter') commit();
          if (event.key === 'Escape') setDraft(entity.name);
        }}
      />
    </Field>
  );
}

function ComponentRow({ component, entityId, disabled, onCommand }: {
  component: Component;
  entityId: string;
  disabled: boolean;
  onCommand(command: SceneCommand): boolean;
}) {
  return (
    <li className="fg-component"><details open><summary className="fg-component-summary">{component.type}</summary>
      <div className="fg-component-head">
        <label className="fg-check">
          <input
            type="checkbox"
            checked={component.enabled}
            disabled={disabled}
            aria-label={`Enabled: ${component.type}`}
            onChange={event => onCommand({ type: 'component', entityId, component: { ...component, enabled: event.currentTarget.checked } })}
          />
          <span>Enabled</span>
        </label>
        <span className="fg-mono fg-muted">{component.id}</span>
        <Button
          variant="ghost"
          disabled={disabled}
          aria-label={`Remove ${component.type} component`}
          onClick={() => onCommand({ type: 'remove-component', entityId, componentId: component.id })}
        >
          Remove
        </Button>
      </div>
      {component.entityRefs.length > 0 ? (
        <p className="fg-component-meta">Entity refs: <span className="fg-mono">{component.entityRefs.join(', ')}</span></p>
      ) : null}
      {component.assetRefs.length > 0 ? (
        <p className="fg-component-meta">Asset refs: <span className="fg-mono">{component.assetRefs.join(', ')}</span></p>
      ) : null}
      <details>
        <summary className="fg-small">Add or remove properties (JSON)</summary>
        <JsonProperty id={`${component.id}-properties`} name="Properties object" value={component.properties} disabled={disabled} onCommit={value => {
          if (value === null || Array.isArray(value) || typeof value !== 'object') return false;
          return onCommand({ type: 'component', entityId, component: { ...component, properties: value } });
        }} />
      </details>
      {Object.keys(component.properties).length > 0 ? (
        <div className="fg-property-list">
          {Object.entries(component.properties).map(([name, value], index) => (
            <PropertyEditor
              key={name}
              id={`${component.id}-property-${index}`}
              name={name}
              value={value}
              disabled={disabled}
              onCommit={next => onCommand({ type: 'component', entityId, component: withProperty(component, name, next) })}
            />
          ))}
        </div>
      ) : (
        <p className="fg-muted fg-small">No properties.</p>
      )}
    </details></li>
  );
}

function PropertyEditor({ id, name, value, disabled, onCommit }: {
  id: string;
  name: string;
  value: JsonValue;
  disabled: boolean;
  onCommit(next: JsonValue): boolean;
}) {
  switch (propertyKind(value)) {
    case 'boolean':
      return (
        <label className="fg-check fg-property">
          <input
            id={id}
            type="checkbox"
            checked={value === true}
            disabled={disabled}
            onChange={event => onCommit(event.currentTarget.checked)}
          />
          <span className="fg-mono">{name}</span>
        </label>
      );
    case 'number':
      return <NumberInput id={id} label={name} value={value as number} disabled={disabled} onCommit={next => onCommit(next)} />;
    case 'vector3':
      return (
        <VectorRow
          title={name}
          idPrefix={id}
          vector={value as Vector}
          disabled={disabled}
          onCommit={next => onCommit(next)}
        />
      );
    case 'string':
      return <TextProperty id={id} name={name} value={value as string} disabled={disabled} onCommit={onCommit} />;
    case 'json':
      return <JsonProperty id={id} name={name} value={value} disabled={disabled} onCommit={onCommit} />;
  }
}

function TextProperty({ id, name, value, disabled, onCommit }: {
  id: string;
  name: string;
  value: string;
  disabled: boolean;
  onCommit(next: JsonValue): boolean;
}) {
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setDraft(value);
    setError(null);
  }, [value]);
  const commit = (): void => {
    if (draft === value) return;
    setError(onCommit(draft) ? null : 'Change rejected. See Console.');
  };
  return (
    <Field label={name} htmlFor={id} error={error}>
      <input
        id={id}
        className={cx('fg-input', error && 'is-invalid')}
        value={draft}
        disabled={disabled}
        onChange={event => setDraft(event.currentTarget.value)}
        onBlur={commit}
        onKeyDown={event => {
          if (event.key === 'Enter') commit();
          if (event.key === 'Escape') setDraft(value);
        }}
      />
    </Field>
  );
}

// Arrays, objects, and mixed lists are edited as JSON. The draft must parse to finite JSON before it is sent.
function JsonProperty({ id, name, value, disabled, onCommit }: {
  id: string;
  name: string;
  value: JsonValue;
  disabled: boolean;
  onCommit(next: JsonValue): boolean;
}) {
  const current = JSON.stringify(value, null, 2);
  const [draft, setDraft] = useState(current);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setDraft(current);
    setError(null);
  }, [current]);
  const commit = (): void => {
    if (draft === current) return;
    const parsed = parseJsonDraft(draft);
    if (!parsed.ok) {
      setError(parsed.message);
      return;
    }
    setError(onCommit(parsed.value) ? null : 'Change rejected. See Console.');
  };
  return (
    <Field label={name} htmlFor={id} error={error} hint="JSON. Applies when you leave the field.">
      <textarea
        id={id}
        className={cx('fg-textarea fg-code-input', error && 'is-invalid')}
        rows={Math.min(8, Math.max(2, draft.split('\n').length))}
        value={draft}
        spellCheck={false}
        disabled={disabled}
        onChange={event => setDraft(event.currentTarget.value)}
        onBlur={commit}
        onKeyDown={event => {
          if (event.key === 'Escape') {
            setDraft(current);
            setError(null);
          }
        }}
      />
    </Field>
  );
}

export function Inspector({ scene, selection, sourcePath, readOnlyReason, conflict, onCommand, onResolveConflict, onAddToAgent }: InspectorProps) {
  const entity = selection.primaryId === null ? undefined : scene.entities.find(item => item.id === selection.primaryId);
  const locked = readOnlyReason !== null || conflict !== null;
  const lockReason = conflict !== null ? 'Resolve the file conflict first. Edits are paused.' : readOnlyReason;
  const [copied, setCopied] = useState(false);
  const [search, setSearch] = useState('');
  const [componentType, setComponentType] = useState('');
  const [componentError, setComponentError] = useState<string | null>(null);

  const copyId = (id: string): void => {
    globalThis.navigator?.clipboard?.writeText(id).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };

  return (
    <aside className="fg-panel fg-inspector" aria-labelledby="inspector-title">
      <header className="fg-panel-header">
        <div>
          <h2 id="inspector-title" className="fg-panel-title">Inspector</h2>
          {sourcePath ? <p className="fg-panel-subtitle fg-mono" title={sourcePath}>{sourcePath}</p> : null}
        </div>
      </header>
      <input type="search" className="fg-input fg-panel-search" aria-label="Search inspector" placeholder="Search components" value={search} onChange={event => setSearch(event.currentTarget.value)} />
      <div className="fg-panel-body">
        {conflict ? <ConflictCard conflict={conflict} onResolve={onResolveConflict} /> : null}
        {lockReason && !conflict ? <Banner tone="warning">{lockReason}</Banner> : null}
        {!entity ? (
          <EmptyState title="Nothing selected">
            Select an object in the hierarchy or viewport. Properties and agent context appear here.
          </EmptyState>
        ) : (
          <>
            <section className="fg-section" aria-label="Object">
              <NameField entity={entity} disabled={locked} onCommit={name => onCommand({ type: 'rename', entityId: entity.id, name })} />
              <div className="fg-id-row">
                <span className="fg-muted">ID</span>
                <span className="fg-mono" data-testid="entity-id">{entity.id}</span>
                <Button variant="ghost" aria-label="Copy entity ID" onClick={() => copyId(entity.id)}>
                  {copied ? 'Copied' : 'Copy'}
                </Button>
              </div>
              {onAddToAgent ? (
                <div className="fg-toolbar">
                  <Button variant="ghost" title="Add this object to the agent message (Ctrl+Shift+L)" onClick={() => onAddToAgent(entity.id, entity.name)}>
                    Add to agent message
                  </Button>
                </div>
              ) : null}
              <dl className="fg-kv">
                <dt>Enabled</dt>
                <dd><input type="checkbox" aria-label="Entity enabled" checked={entity.enabled} disabled={locked} onChange={event => onCommand({ type: 'enabled', entityId: entity.id, enabled: event.currentTarget.checked })} /></dd>
                {entity.prefab ? (
                  <>
                    <dt>Prefab</dt>
                    <dd className="fg-mono">{entity.prefab.prefabId} · instance {entity.prefab.instanceId}</dd>
                  </>
                ) : null}
              </dl>
            </section>
            <details className="fg-section" aria-label="Transform" open hidden={!!search && !'transform position rotation scale'.includes(search.toLowerCase())}>
              <summary className="fg-section-title">Transform</summary>
              <VectorRow
                title="Position"
                idPrefix="position"
                vector={entity.transform.position}
                disabled={locked}
                onCommit={position => onCommand({ type: 'transform', entityId: entity.id, transform: { ...entity.transform, position } })}
              />
              <VectorRow
                title="Rotation (degrees)"
                idPrefix="rotation"
                vector={entity.transform.rotationEuler}
                disabled={locked}
                onCommit={rotationEuler => onCommand({ type: 'transform', entityId: entity.id, transform: { ...entity.transform, rotationEuler } })}
              />
              <VectorRow
                title="Scale"
                idPrefix="scale"
                vector={entity.transform.scale}
                disabled={locked}
                onCommit={scale => onCommand({ type: 'transform', entityId: entity.id, transform: { ...entity.transform, scale } })}
              />
            </details>
            <section className="fg-section" aria-label="Components">
              <h3 className="fg-section-title">Components</h3>
              {entity.components.length === 0 ? (
                <p className="fg-muted">No components on this object.</p>
              ) : (
                <ul className="fg-list-plain">
                  {entity.components.filter(component => !search || component.type.toLowerCase().includes(search.toLowerCase()) || Object.keys(component.properties).some(name => name.toLowerCase().includes(search.toLowerCase()))).map(component => (
                    <ComponentRow key={component.id} component={component} entityId={entity.id} disabled={locked} onCommand={onCommand} />
                  ))}
                </ul>
              )}
              <details className="fg-add-component"><summary>+ component</summary>
                <form onSubmit={event => {
                  event.preventDefault();
                  const type = componentType.trim();
                  if (!type || !entity) return;
                  const ok = onCommand({ type: 'component', entityId: entity.id, component: { id: createId('component'), type, enabled: true, properties: {}, entityRefs: [], assetRefs: [] } });
                  setComponentError(ok ? null : 'Component rejected. See Console.');
                  if (ok) setComponentType('');
                }}>
                  <label className="fg-field">Component type<input className="fg-input" aria-label="Component type" value={componentType} disabled={locked} onChange={event => setComponentType(event.currentTarget.value)} required /></label>
                  <Button type="submit" disabled={locked || !componentType.trim()}>Add component</Button>
                  {componentError ? <p role="alert">{componentError}</p> : null}
                </form>
              </details>
            </section>
          </>
        )}
      </div>
    </aside>
  );
}
