import { useEffect, useId, useState } from 'react';
import { format } from '../../../../packages/i18n/src/index';
import { useTranslation } from '../../../../packages/i18n/src/react';
import { Field, Input } from '../theme';

export default function LoginServiceField({ value, onChange, names }: {
  value: string; onChange: (value: string) => void; names: string[];
}) {
  const { dict: { itemForm: f } } = useTranslation();
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(-1);
  const name = query.trim();
  const normalized = name.toLowerCase();
  const options = names.filter((service) => service.toLowerCase().includes(normalized))
    .map((service) => ({ name: service, label: service }));
  if (name && !options.some((option) => option.name.toLowerCase() === normalized)) {
    options.push({ name, label: format(f.createLoginService, name) });
  }
  const expanded = open && options.length > 0;
  const activeId = expanded && options[active] ? `${listId}-${active}` : undefined;
  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView({ block: 'nearest' });
  }, [activeId]);

  const close = () => { setOpen(false); setQuery(''); setActive(-1); };
  const choose = (name: string) => { onChange(name); close(); };
  return (
    <div className="relative">
      <Field id="item-title" label={f.loginService}>
        <Input
          name="item-title"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={expanded}
          aria-controls={expanded ? listId : undefined}
          aria-activedescendant={activeId}
          autoComplete="off"
          placeholder={f.loginServicePlaceholder}
          value={value}
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          onBlur={close}
          onChange={(event) => { onChange(event.target.value); setQuery(event.target.value); setActive(-1); setOpen(true); }}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && open) {
              event.stopPropagation();
              close();
            } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && options.length > 0) {
              event.preventDefault();
              setOpen(true);
              setActive(event.key === 'ArrowDown' ? Math.min(active + 1, options.length - 1) : active <= 0 ? options.length - 1 : active - 1);
            } else if (event.key === 'Enter' && expanded && options[active]) {
              event.preventDefault();
              choose(options[active].name);
            }
          }}
        />
      </Field>
      {expanded && (
        <ul id={listId} role="listbox" aria-label={f.loginService} className="ms-menu absolute inset-x-0 top-full -mt-3 max-h-56 max-w-none overflow-y-auto">
          {options.map((option, index) => (
            <li key={option.name} id={`${listId}-${index}`} role="option" aria-selected={active === index}
              data-highlighted={active === index ? '' : undefined}
              className="ms-menu__item"
              onPointerDown={(event) => event.preventDefault()}
              onPointerMove={() => setActive(index)}
              onClick={() => choose(option.name)}
            >
              {option.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
