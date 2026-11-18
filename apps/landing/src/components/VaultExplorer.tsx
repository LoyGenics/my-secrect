'use client';

import { useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { ArrowUpRight, LockKeyhole } from 'lucide-react';
import { typeArt } from '../assets';

export default function VaultExplorer({ items, label, note }: { items: string[]; label: string; note: string }) {
  const [selected, setSelected] = useState(0);
  const reduced = useReducedMotion();
  return (
    <div className="explorer">
      <div className="explorer__choices" role="group" aria-label={label}>
        {items.map((item, i) => (
          <button className={`explorer__choice${selected === i ? ' is-selected' : ''}`} key={item} type="button" aria-pressed={selected === i} onClick={() => setSelected(i)}>
            <img src={typeArt[i]} alt="" width={40} height={40} loading="lazy" />
            <span>{item}</span><ArrowUpRight size={16} aria-hidden="true" />
          </button>
        ))}
      </div>
      <div className="explorer__display" aria-live="polite" aria-atomic="true">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div className="explorer__object" key={selected} initial={reduced ? false : { opacity: 0, y: 18, rotate: -5 }} animate={{ opacity: 1, y: 0, rotate: 0 }} exit={reduced ? undefined : { opacity: 0, y: -12 }} transition={{ duration: 0.24 }}>
            <img src={typeArt[selected]} alt="" width={240} height={240} />
            <h3>{items[selected]}</h3>
          </motion.div>
        </AnimatePresence>
        <p><LockKeyhole size={15} aria-hidden="true" />{note}</p>
      </div>
    </div>
  );
}
