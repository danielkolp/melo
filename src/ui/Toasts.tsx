import { useEffect, useState } from 'react';
import { useStudio } from '../state/useStudio';
import { cx } from './controls';

export function Toasts() {
  const toast = useStudio((s) => s.toast);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!toast) return;
    setVisible(true);
    const t = setTimeout(() => setVisible(false), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  return (
    <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-24 z-40 flex justify-center px-4">
      {toast && (
        <div
          className={cx(
            'readout rounded-full bg-fg px-4 py-2 text-[11.5px] text-inverse shadow-lg transition-all duration-300',
            visible ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0',
          )}
        >
          {toast.message}
        </div>
      )}
    </div>
  );
}
