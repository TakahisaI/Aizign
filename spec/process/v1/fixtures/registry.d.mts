export type ProcessProfileRegistry = {
  run<T>(caseId: string, assertion: () => T | Promise<T>): Promise<T>;
  record(...caseIds: string[]): void;
  complete(): void;
};

export function expectedProcessProfileCaseIds(owner: string): string[];

export function createProcessProfileRegistry(owner: string): ProcessProfileRegistry;
