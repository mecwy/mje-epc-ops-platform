/** Dev-only embedded consumer. Construction/import has no timer, claim, HTTP or DB side effect. */
export interface WeatherRuntimeDependencies {
  enabled?: boolean;
  deploymentEnvironment?: string;
  /** Trusted server configuration; never a client org/role or an Entra tenant fallback. */
  businessOrgId?: string;
  runOnce: (businessOrgId: string, signal: AbortSignal) => Promise<unknown>;
}
export function createWeatherRuntime(deps: WeatherRuntimeDependencies) {
  const enabled = deps.enabled === true;
  if (
    enabled &&
    (deps.deploymentEnvironment !== 'dev' ||
      !deps.businessOrgId ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        deps.businessOrgId,
      ))
  )
    throw new Error('WEATHER_DEV_CONFIGURATION_REQUIRED');
  let started = false,
    stopped = false,
    wakePending = false,
    failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<void> | undefined,
    controller: AbortController | undefined;
  let stopping: Promise<void> | undefined;
  const schedule = (delay: number) => {
    if (stopped || !started || !enabled || timer !== undefined || active)
      return;
    timer = setTimeout(() => {
      timer = undefined;
      round();
    }, delay);
  };
  const round = () => {
    if (stopped || active || !enabled) return;
    controller = new AbortController();
    const signal = controller.signal;
    active = Promise.resolve()
      .then(async () => {
        if (stopped) return;
        try {
          await deps.runOnce(deps.businessOrgId!, signal);
          failures = 0;
        } catch {
          failures = Math.min(failures + 1, 5);
        }
      })
      .finally(() => {
        active = undefined;
        controller = undefined;
        if (stopped) return;
        const delay = wakePending ? 0 : Math.min(30000, 2000 * 2 ** failures);
        wakePending = false;
        schedule(delay);
      });
  };
  return {
    start() {
      if (started || stopped || !enabled) return;
      started = true;
      schedule(0);
    },
    /** Optional hint after a committed request. Polling also resumes idle/failure/cleanup rounds. */
    wake() {
      if (!started || stopped || !enabled) return;
      if (active) {
        wakePending = true;
        return;
      }
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      schedule(0);
    },
    /** Single boot owner awaits this before closing the pool. Repeated stops join the same drain. */
    stop(): Promise<void> {
      if (stopping) return stopping;
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      controller?.abort();
      stopping = Promise.resolve(active).then(() => undefined);
      return stopping;
    },
  };
}
