import { useMemo } from 'react';
import type { VaultItem } from '../../../../packages/core/src/types';
import { computeHealth } from '../utils/health';
import { Button, Card, Dial, EmptyState, Led, TypeModule, illustrations } from '../theme';
import { useTranslation } from '../../../../packages/i18n/src/react';
import { format } from '../../../../packages/i18n/src/index';

export interface HealthViewProps {
  items: VaultItem[];
  onFix: (item: VaultItem) => void;
}

/**
 * Watchtower: one instrument dial owns the panel (score as the needle arc,
 * LED colour by band, LCD readout), with weak and reused passwords listed
 * beside it, each with a Fix key.
 */
export default function HealthView({ items, onFix }: HealthViewProps) {
  const { dict, tp } = useTranslation();
  const h = dict.health;
  const report = useMemo(() => computeHealth(items), [items]);
  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const tone = report.score >= 80 ? 'ok' : report.score >= 50 ? 'attention' : 'danger';
  const status = report.score >= 80 ? h.status.ok : report.score >= 50 ? h.status.attention : h.status.danger;

  if (report.total === 0) {
    return <EmptyState art={illustrations.emptyVault} title={h.title} body={h.emptyHint} />;
  }

  return (
    <div className="grid gap-4">
      <Card as="section" padding="lg" aria-labelledby="health-title">
        <div className="grid items-center gap-6 md:grid-cols-[220px_minmax(0,1fr)]">
          <Dial value={report.score} label={format(h.dialLabel, report.score)} legend={h.outOf} size={220} className="mx-auto" />
          <div className="grid gap-2">
            <h2 id="health-title" className="ms-heading ms-heading--lg">{h.title}</h2>
            <p className="ms-copy-led ms-legend m-0">
              <Led tone={tone} /> {status}
            </p>
            <ul className="m-0 grid list-none gap-1 p-0 ms-text-secondary">
              <li>{tp(h.itemsChecked, report.total)}</li>
              <li>{tp(h.weakCount, report.weakCount)}</li>
              <li>{tp(h.reusedCount, report.reusedCount)}</li>
            </ul>
          </div>
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card as="section" aria-labelledby="health-weak">
          <div className="ms-plate__head">
            <Led tone={report.weakItems.length ? 'danger' : 'ok'} />
            <h3 id="health-weak" className="ms-heading ms-heading--md">{h.weakTitle}</h3>
          </div>
          <p className="ms-text-sm ms-text-muted mt-0">{h.weakHint}</p>
          {report.weakItems.length === 0 ? (
            <p className="m-0">{h.noWeak}</p>
          ) : (
            <ul className="ms-spec__list">
              {report.weakItems.map((item) => (
                <li key={item.id} className="flex items-center gap-3">
                  <TypeModule type={item.type} size="sm" />
                  <span className="min-w-0 flex-1 truncate">{item.title}</span>
                  <Button size="sm" icon="edit" aria-label={format(h.fixItem, item.title)} onClick={() => onFix(item)}>
                    {h.fix}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card as="section" aria-labelledby="health-reused">
          <div className="ms-plate__head">
            <Led tone={report.reusedGroups.length ? 'attention' : 'ok'} />
            <h3 id="health-reused" className="ms-heading ms-heading--md">{h.reusedTitle}</h3>
          </div>
          <p className="ms-text-sm ms-text-muted mt-0">{h.reusedHint}</p>
          {report.reusedGroups.length === 0 ? (
            <p className="m-0">{h.noReused}</p>
          ) : (
            <ul className="ms-spec__list gap-3">
              {report.reusedGroups.map((group, gi) => (
                <li key={gi}>
                  <span className="ms-legend block mb-1.5">{tp(h.sharedBy, group.itemIds.length)}</span>
                  <ul className="ms-spec__list">
                    {group.itemIds.map((id) => {
                      const item = byId.get(id);
                      if (!item) return null;
                      return (
                        <li key={id} className="flex items-center gap-3">
                          <TypeModule type={item.type} size="sm" />
                          <span className="min-w-0 flex-1 truncate">{item.title}</span>
                          <Button size="sm" icon="edit" aria-label={format(h.fixItem, item.title)} onClick={() => onFix(item)}>
                            {h.fix}
                          </Button>
                        </li>
                      );
                    })}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
