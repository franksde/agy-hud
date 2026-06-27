import { loadFromPaths, configPaths } from './src/config';
console.log(configPaths());
console.log(loadFromPaths(configPaths()));
