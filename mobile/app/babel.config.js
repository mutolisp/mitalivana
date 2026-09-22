module.exports = function (api) {
  api.cache(true);
  return {
    presets: [
      ['babel-preset-expo', { jsxImportSource: 'nativewind' }],
      'nativewind/babel',
    ],
    // `react-native-worklets-core/plugin` used to be here for vision-camera
    // Frame Processors. VisionCamera and the inatvision plugin were removed in
    // 2026-09; nothing imports worklets-core any more, so the plugin only cost
    // build time. Reanimated 4 uses `react-native-worklets` — a DIFFERENT
    // package — and babel-preset-expo wires that one up itself.
  };
};
