import './styles/Everygrid.css';
import {Everygrid} from './core/Everygrid';

export {Everygrid} from './core/Everygrid';
export {Everygrid as default} from './core/Everygrid';
export {GridHandle, RowHandle, CellHandle, ColumnHandle} from './core/GridHandle';
export type {RowKey, RowStatus, CellChange, RowChange, ColumnChange, RowPatch, RowDeletion, Patch, CellChangeEvent, CheckEvent, GridEvents} from './core/GridHandle';

// Ergonomic functional API (thin wrappers over the static methods above). Import these directly, or
// reach them as statics on the global (`Everygrid.mountGrid`) in the standalone build.
export const loadEverygridConfig = Everygrid.loadEverygridConfig;
export const mountGrid = Everygrid.mountGrid;
export const unmountGrid = Everygrid.unmountGrid;
/** @deprecated Use {@link mountGrid} — same arguments. Still works. */
export const createGrid = Everygrid.createGrid;
export type {GridSource} from './core/Everygrid';

// React bindings (React is a peerDependency). Also re-exported from the `./react` subpath.
export {useGrid, EverygridGrid, useEverygridLocale, EverygridLocaleSwitch} from './react';
export type {EverygridGridProps, EverygridLocaleOptions, EverygridLocaleSwitchProps} from './react';
export {GridEngineWasm} from './wasm/GridEngineWasm';
export {I18n} from './i18n/I18n';
export {GlobeIcon} from './icons/GlobeIcon';
export {ChevronDownIcon} from './icons/ChevronDownIcon';
export type {IconName, IconSource} from './icons/registry';

export type {
  ReloadOptions,
  GridOptions,
  GridColumn,
  ColumnI18n,
  GridMobileColumnsConfig,
  GridTargetConfig,
  GridPaginationConfig,
  GridColorConfig,
  EditableColConfig,
  GridRowKeyConfig,
  GridRowActionsConfig,
  GridToolbarConfig,
  GridLinkConfig,
  EverygridPublic as IEverygrid,
  GridLoadProgress,
  ServerFetchParams,
  ServerFetchResult,
} from './core/types';
