export const deployConfig = Object.freeze({
  productionDomain: 'marketingtool-mocha.vercel.app',
  productionUrl: 'https://marketingtool-mocha.vercel.app',
  productionVersionPath: '/version.json',
});

export const productionDomain = deployConfig.productionDomain;
export const productionUrl = deployConfig.productionUrl;
export const productionVersionPath = deployConfig.productionVersionPath;
export const productionVersionUrl = `${productionUrl}${productionVersionPath}`;
