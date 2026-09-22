/**
 * Raise every pod to at least the app's own iOS minimum.
 *
 * CocoaPods honours each podspec's own `deployment_target`, so pods that still
 * declare iOS 9 / 11 / 12 (SDWebImage, RNSVG, react-native-maps) arrive
 * unchanged no matter what `platform :ios` says. Xcode 27 refuses anything
 * below 15.0, which is what broke the Xcode Cloud archive with "the range of
 * supported deployment target versions is 15.0 to 27.0.x".
 *
 * Why a config plugin and not the `post_install` block this replaces:
 * `ios/` is a prebuild artefact that merely happens to be committed, so
 * `expo prebuild --clean` regenerates the Podfile and silently drops a hand
 * edit. The Podfile itself said so — and the failure it warned about only
 * surfaces in CI, on an archive, long after the prebuild that caused it.
 * Same reasoning as `withBackupExclusions` next door.
 *
 * Idempotent: the block is fenced with a marker and re-inserted only when the
 * marker is absent, so running prebuild twice does not stack copies.
 */
const { withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const MARKER = '# @mitalivana min-deployment-target';

/** Ruby appended inside `post_install do |installer|`. */
function block(minTarget) {
  return `
    ${MARKER} — see plugins/withPodMinDeploymentTarget.js
    min_target = podfile_properties['ios.deploymentTarget'] || '${minTarget}'
    installer.pods_project.targets.each do |target|
      target.build_configurations.each do |build_config|
        current = build_config.build_settings['IPHONEOS_DEPLOYMENT_TARGET']
        if current.nil? || current.to_f < min_target.to_f
          build_config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = min_target
        end
      end
    end
`;
}

/**
 * The Podfile edit itself — pure, so `node plugins/withPodMinDeploymentTarget.js`
 * can exercise it without standing up an Expo prebuild. Returns the source
 * unchanged when the block is already present.
 */
function injectMinTargetBlock(src, minTarget = '15.1') {
  if (src.includes(MARKER)) return src;
  const at = src.indexOf('post_install do |installer|');
  if (at === -1) {
    throw new Error(
      'withPodMinDeploymentTarget: no post_install block in the Podfile. ' +
        'Expo changed the template — update this plugin rather than letting ' +
        'the pods keep their own deployment targets.',
    );
  }
  // The first `\n  end\n` after post_install closes it (two-space indent is the
  // template's; anything nested is indented further).
  const close = src.indexOf('\n  end\n', at);
  if (close === -1) {
    throw new Error('withPodMinDeploymentTarget: could not find the end of post_install.');
  }
  return src.slice(0, close) + '\n' + block(minTarget) + src.slice(close);
}

module.exports = function withPodMinDeploymentTarget(config, { minTarget = '15.1' } = {}) {
  return withDangerousMod(config, [
    'ios',
    (cfg) => {
      const podfile = path.join(cfg.modRequest.platformProjectRoot, 'Podfile');
      const src = fs.readFileSync(podfile, 'utf8');
      const next = injectMinTargetBlock(src, minTarget);
      if (next !== src) fs.writeFileSync(podfile, next);
      return cfg;
    },
  ]);
};

module.exports.injectMinTargetBlock = injectMinTargetBlock;
