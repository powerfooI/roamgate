// Keep the catalog limited to the two themes exposed by the diff viewer.
const loaders = {
  "pierre-dark": () => import("@pierre/theme/pierre-dark"),
  "pierre-light": () => import("@pierre/theme/pierre-light"),
};

export const themes = {
  getTheme(name: string) {
    if (!Object.prototype.hasOwnProperty.call(loaders, name)) return undefined;
    return { load: loaders[name as keyof typeof loaders] };
  },
};
