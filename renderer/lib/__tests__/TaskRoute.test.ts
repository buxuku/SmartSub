import { isTaskRouteHydrated, taskRouteKey } from '../taskRoute';

const base = {
  slug: 'generate-translate',
  queryProject: '',
  projectId: 'p1' as string | null,
};

describe('isTaskRouteHydrated', () => {
  it('is not hydrated before the first load', () => {
    expect(isTaskRouteHydrated({ ...base, hydratedRoute: null })).toBe(false);
  });

  it('is hydrated when the loaded route is the current route', () => {
    expect(
      isTaskRouteHydrated({
        ...base,
        hydratedRoute: taskRouteKey('generate-translate', ''),
      }),
    ).toBe(true);
    expect(
      isTaskRouteHydrated({
        ...base,
        queryProject: 'p1',
        hydratedRoute: taskRouteKey('generate-translate', 'p1'),
      }),
    ).toBe(true);
  });

  it('stays hydrated when the URL only catches up with the loaded project', () => {
    // 新任务装载后首次自动保存：router.replace 补上 ?project=p1，不应回到整页加载态。
    expect(
      isTaskRouteHydrated({
        ...base,
        queryProject: 'p1',
        hydratedRoute: taskRouteKey('generate-translate', ''),
      }),
    ).toBe(true);
  });

  it('reloads when the URL points at a different project', () => {
    expect(
      isTaskRouteHydrated({
        ...base,
        queryProject: 'p2',
        hydratedRoute: taskRouteKey('generate-translate', ''),
      }),
    ).toBe(false);
    expect(
      isTaskRouteHydrated({
        ...base,
        queryProject: 'p2',
        hydratedRoute: taskRouteKey('generate-translate', 'p1'),
      }),
    ).toBe(false);
  });

  it('reloads when leaving a saved project for a new task', () => {
    expect(
      isTaskRouteHydrated({
        ...base,
        queryProject: '',
        hydratedRoute: taskRouteKey('generate-translate', 'p1'),
      }),
    ).toBe(false);
  });

  it('reloads when the task type changes, even with the same project id', () => {
    expect(
      isTaskRouteHydrated({
        ...base,
        slug: 'transcribe',
        queryProject: 'p1',
        hydratedRoute: taskRouteKey('generate-translate', ''),
      }),
    ).toBe(false);
  });

  it('does not treat an unloaded project as hydrated', () => {
    expect(
      isTaskRouteHydrated({
        ...base,
        projectId: null,
        queryProject: 'p1',
        hydratedRoute: taskRouteKey('generate-translate', ''),
      }),
    ).toBe(false);
  });
});
