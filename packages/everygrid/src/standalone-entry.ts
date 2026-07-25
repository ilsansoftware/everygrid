import './styles/Everygrid.css';
import { Everygrid } from './core/Everygrid';

// Default-only export so the UMD global `window.Everygrid` IS the class (with its statics:
// createGrid, loadEverygridConfig, setLocale, I18n, …). The React binding (useGrid) is not bundled
// here — it lives in the ES build (`@everygrid/grid`) for bundler consumers.
export default Everygrid;
