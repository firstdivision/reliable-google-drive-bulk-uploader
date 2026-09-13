import { createRoot } from 'react-dom/client';
import '@fontsource/dm-sans/latin-400.css';
import '@fontsource/dm-sans/latin-500.css';
import '@fontsource/dm-sans/latin-600.css';
import '@fontsource/manrope/latin-600.css';
import '@fontsource/manrope/latin-700.css';
import { DashboardController } from './controller';
import { Dashboard } from './Dashboard';
import { GoogleFolderPicker } from './drive-picker';
import './style.css';

const controller = new DashboardController({ picker: new GoogleFolderPicker({
	apiKey: import.meta.env.VITE_GOOGLE_PICKER_API_KEY || '',
	appId: import.meta.env.VITE_GOOGLE_PICKER_APP_ID || '',
}) });
createRoot(document.getElementById('root')!).render(<Dashboard controller={controller} />);
void controller.initialize();