/** A card, by where it's laid out. */
export interface Placed {
  col: number;
  top: number;
  height: number;
}

/** Where in `cards` something dragged goes, with the pointer `y` down column `col`: before the
 * first card of the column whose middle is below the pointer, else after its last. The same for
 * every card and column, wherever what's dragged came from. Nothing in the column: at the end. */
export function slotInColumn(cards: Placed[], col: number, y: number): number {
  let last = -1;
  for (let i = 0; i < cards.length; i++) {
    if (cards[i].col !== col) continue;
    if (y < cards[i].top + cards[i].height / 2) return i;
    last = i;
  }
  return last < 0 ? cards.length : last + 1;
}

/** What's shown follows what's seen only once that has held for `ms`: a value that comes and goes
 * (the pointer on the line between two columns, shaking) changes nothing. The first is at once. */
export class Settling<T> {
  private shown: { key: string; value: T } | null = null;
  private next: { key: string; timer: ReturnType<typeof setTimeout> } | null = null;
  private ms: number;
  private onChange: (value: T) => void;

  constructor(ms: number, onChange: (value: T) => void) {
    this.ms = ms;
    this.onChange = onChange;
  }

  /** The pointer says `value` now (`key`: what it is, to compare). What's shown, for now. */
  see(key: string, value: T): T {
    if (!this.shown) {
      this.shown = { key, value };
      this.onChange(value);
    } else if (key === this.shown.key) {
      this.cancel();
    } else if (key !== this.next?.key) {
      this.cancel();
      this.next = {
        key,
        timer: setTimeout(() => {
          this.next = null;
          this.shown = { key, value };
          this.onChange(value);
        }, this.ms),
      };
    }
    return this.shown.value;
  }

  private cancel() {
    if (this.next) clearTimeout(this.next.timer);
    this.next = null;
  }

  /** It's over: the next one seen is at once. */
  clear() {
    this.cancel();
    this.shown = null;
  }
}
