// The demo's AI search: the grid posts the question and its field list to the demo's endpoint
// (demo/ai-search, a Lambda built on @everygrid/grid/ai-server), which builds the prompt and calls
// the model. No endpoint configured (VITE_AI_SEARCH_URL unset) → the AI search button stays hidden.
import {Everygrid} from '@everygrid/grid';

const endpoint = import.meta.env.VITE_AI_SEARCH_URL as string | undefined;

if (endpoint) { Everygrid.setAiSearch({endpoint}); }
