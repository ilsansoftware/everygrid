import './styles/Everygrid.css';
import {Everygrid} from './core/Everygrid';

export {Everygrid} from './core/Everygrid';
export {Everygrid as default} from './core/Everygrid';

// Ergonomic functional API (thin wrappers over the static methods above). Import these directly, or
// reach them as statics on the global (`Everygrid.createEverygrid`) in the standalone build.
export const loadEverygridConfig = Everygrid.loadEverygridConfig;
export const createEverygrid = Everygrid.createEverygrid;
export {GridEngineWasm} from './wasm/GridEngineWasm';
export {I18n} from './i18n/I18n';
export {ModalHost} from './modal/ModalHost';
export {GlobeIcon} from './icons/GlobeIcon';
export {ChevronDownIcon} from './icons/ChevronDownIcon';

export type {
  GridOptions,
  GridColumn,
  ColumnI18n,
  GridMobileColumnsConfig,
  GridTargetConfig,
  GridPaginationConfig,
  GridColorConfig,
  EditableColConfig,
  GridRowCheckboxConfig,
  GridLinkConfig,
  IEverygrid,
  ServerFetchParams,
  ServerFetchResult,
} from './core/types';
