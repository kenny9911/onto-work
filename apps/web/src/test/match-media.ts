type MediaListener = (event: MediaQueryListEvent) => void;

export class MatchMediaController {
  readonly media: string;
  matches = false;
  onchange: MediaListener | null = null;
  private readonly listeners = new Set<MediaListener>();

  constructor(media: string) {
    this.media = media;
  }

  addEventListener(_type: "change", listener: MediaListener): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: "change", listener: MediaListener): void {
    this.listeners.delete(listener);
  }

  addListener(listener: MediaListener): void {
    this.listeners.add(listener);
  }

  removeListener(listener: MediaListener): void {
    this.listeners.delete(listener);
  }

  dispatchEvent(event: Event): boolean {
    for (const listener of this.listeners) listener(event as MediaQueryListEvent);
    return true;
  }

  setMatches(matches: boolean): void {
    if (this.matches === matches) return;
    this.matches = matches;
    const event = { matches, media: this.media } as MediaQueryListEvent;
    this.onchange?.(event);
    for (const listener of this.listeners) listener(event);
  }
}

export function controlledMatchMedia(): {
  controller: (query: string) => MatchMediaController;
  matchMedia: (query: string) => MediaQueryList;
} {
  const controllers = new Map<string, MatchMediaController>();
  const controller = (query: string) => {
    const existing = controllers.get(query);
    if (existing) return existing;
    const next = new MatchMediaController(query);
    controllers.set(query, next);
    return next;
  };
  return {
    controller,
    matchMedia: (query) => controller(query) as unknown as MediaQueryList,
  };
}
