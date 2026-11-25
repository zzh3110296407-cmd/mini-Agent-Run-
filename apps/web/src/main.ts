import { createApp } from 'vue';
import App from './App.vue';
import { applyWorkbenchTheme, readWorkbenchTheme } from './composables/useWorkbenchLayout';
import './styles/tokens.css';
import './styles/base.css';
import './styles/uiverse-inputs.css';

applyWorkbenchTheme(readWorkbenchTheme());
createApp(App).mount('#app');
