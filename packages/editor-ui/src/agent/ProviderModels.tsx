import { useMemo, useState } from 'react';
import type { AgentProviderInfo } from '../services.js';
import { Button } from '../primitives/primitives.js';
import { matchesModel, modelLabel } from './modelPickerModel.js';

export function ProviderModels({ provider }: { provider: AgentProviderInfo }) {
  const [query, setQuery] = useState('');
  const [all, setAll] = useState(false);
  const matches = useMemo(() => provider.models.filter(model => matchesModel(model, query)), [provider.models, query]);
  const limit = all ? matches.length : query.trim() ? 100 : 12;
  return <details className="fg-provider-models">
    <summary>{provider.models.length} models</summary>
    {provider.models.length === 0 ? <p className="fg-small fg-muted">Not reported</p> : <>
      <input className="fg-input" aria-label={`Search ${provider.name} models`} placeholder="Search models…" value={query}
        onChange={event => setQuery(event.currentTarget.value)} />
      <ul className="fg-provider-model-list" aria-label={`${provider.name} models`}>
        {matches.slice(0, limit).map(model => {
          const display = modelLabel(model, provider.id);
          return <li key={model} title={model}><span className="fg-model-name">{display.label}</span>{display.vendor ? <span className="fg-model-vendor">{display.vendor}</span> : null}</li>;
        })}
      </ul>
      {matches.length === 0 ? <p className="fg-small fg-muted" role="status">No models match.</p> : null}
      {!query.trim() && matches.length > 12 ? <Button onClick={() => setAll(value => !value)}>{all ? 'Show fewer' : 'Show all'}</Button> : null}
      {matches.length > limit ? <p className="fg-small fg-muted" role="status">{matches.length - limit} more{limit === 100 ? ' — refine search' : ''}</p> : null}
    </>}
  </details>;
}
