import type { GameState } from '../types';

export interface Feed {
  readonly name: string;
  poll(): Promise<GameState[]>;
  start(intervalMs: number, onUpdate: (states: GameState[]) => void): void;
  stop(): void;
}
