import { useCallback, useEffect, useState } from "react";

/** The size of the element given the returned callback ref, following every
 * resize -- for layouts that adapt to the room they actually get rather than
 * to the window's. A callback ref, so an element mounted later (or replaced)
 * is picked up too. */
export function useElementSize<T extends Element>(): [(el: T | null) => void, { width: number; height: number }] {
  const [element, setElement] = useState<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const ref = useCallback((el: T | null) => setElement(el), []);

  useEffect(() => {
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const width = Math.round(entry.contentRect.width);
      const height = Math.round(entry.contentRect.height);
      setSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);

  return [ref, size];
}
