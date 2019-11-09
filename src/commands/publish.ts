import { join } from 'path';
import { readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';

import { changedPackages } from './changed';
import { getConfig, packageMaps, versionUpgradeStep } from '../config';
import { logError, logSuccess } from '../utils/log';

/**
 * 1. check current publish branch config
 * 2. get version step config
 * 3. change version, change linked version(would not change to alpha/beta version)
 * 4. generate changelog
 * 5. get message config, commit to branch
 * 6. publish
 * 7. commit to commitBranch
 */

const config = getConfig();
const publishedPackages: IPublishedPackage[] = [];

const getNewVersion = (version: string) => {
  if (config.versionUpgradeStep === versionUpgradeStep.major) {
    // 0.0.1 => 1.0.0
    return version.replace(/(\d.*)/, (match, $1) => {
      return `${parseInt($1, 10) + 1}.0.0`;
    });
  } else if (config.versionUpgradeStep === versionUpgradeStep.minor) {
    // 0.0.1 => 0.1.0
    return version.replace(/(\d+\.)(\d.*)/, (match, $1, $2) => {
      return `${$1}${parseInt($2, 10) + 1}.0`;
    });
  } else if (config.versionUpgradeStep === versionUpgradeStep.patch) {
    // 0.0.1 => 0.0.2
    return version.replace(/(\d+\.\d+\.)(\d.*)/, (match, $1, $2) => {
      return `${$1}${parseInt($2, 10) + 1}`;
    });
  } else {
    // 0.0.1 => 0.0.1-alpha.xxxxxxx
    const commitHash = execSync('git rev-parse HEAD').toString();
    const step = config.versionUpgradeStep;
    return version.replace(/(\d+\.\d+\.)(\d.*)/, (match, $1, $2) => {
      return `${$1}${parseInt($2, 10)}-${step}.${commitHash.substring(0, 7)}`;
    });
  }
};

const changePackageVersion = (pkgPath: string, newVersion: string) => {
  const packageJsonFile = join(pkgPath, '/package.json');
  const newJsonString = readFileSync(packageJsonFile).toString()
    .replace(/("version": ")(.*?)"/, (match, $1, $2) => `${$1}${newVersion}"`);
  writeFileSync(packageJsonFile, newJsonString);
};

const changePackageDependencyVersion = (pkgPath: string, dependencyName: string, dependencyVersion: string) => {
  const packageJsonFile = join(pkgPath, '/package.json');
  const reg = new RegExp(`("${dependencyName}": ")(.*?)"`);
  const newJsonString = readFileSync(packageJsonFile).toString()
    .replace(reg, (match, $1, $2) => `${$1}${dependencyVersion}"`);
  writeFileSync(packageJsonFile, newJsonString);
};

const publishPackage = ({ name, version, path }: IPackageInfo) => {
  const newVersion = getNewVersion(version);
  changePackageVersion(path, newVersion);
  execSync(`npm publish --registry ${config.publishRegistry}`, { cwd: path });
  publishedPackages.push({ name, previousVersion: version, newVersion });
};

const execPublish = () => {
  /**
   * loop changed packages
   * get package.json, change the version by step
   * loop packageMaps, also change packages version which depends on the package
   */
  changedPackages.forEach(({ name, version, packagesLinkThePackage }) => {
    // prevent publishing when the package is in the blacklist
    if (config.publishBlacklist.includes(name)) { return ; }

    const pkg = packageMaps.find(pkg => pkg.name === name);
    const newVersion = getNewVersion(version);
    publishPackage({ path: pkg!.path, version, name });

    if (!config.shouldPublishWhenDependencyPublished) { return ; }

    packagesLinkThePackage.forEach(({ path: linkedPkgPath, version: linkedPkgVersion, name: linkedPkgName }) => {
      if (config.publishBlacklist.includes(linkedPkgName)) {
        // prevent publishing when the package is in the blacklist
      } else {
        changePackageDependencyVersion(linkedPkgPath, name, newVersion);
        if (changedPackages.find(pkg => pkg.name === linkedPkgName)) {
          // do nothing when the package has exist in changed packages
        } else {
          publishPackage({ path: linkedPkgPath, version: linkedPkgVersion, name: linkedPkgName });
        }
      }
    });
  });

  const publishedPackagesInfo = publishedPackages
    .map(item => `${item.name} ${item.previousVersion} => ${item.newVersion}`)
    .join('\n');
  logSuccess('publish packages successfully: ', `\n${publishedPackagesInfo}`);
};

const commitMessage = (commitBranch: string) => {
  /**
   * read message config
   * commit with specified message
   * git commit to commit branch
   */
  const commitDetails = publishedPackages.map(item => ` -m "- ${item.name}@${item.newVersion}"`).join('');
  execSync('git add .');
  execSync(`git commit -m "${config.commitMessage}" ${commitDetails}`);
  execSync(`git push origin HEAD:${commitBranch.replace(/origin\//, '')}`);
};

execPublish();
if (config.commitBranch) { commitMessage(config.commitBranch); }
