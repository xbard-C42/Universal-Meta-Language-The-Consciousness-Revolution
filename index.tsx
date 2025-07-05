
import React, { useState, useCallback, useRef, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { Document, Page, pdfjs, PDFDocumentProxy, PageProxy } from 'react-pdf';
import {
    ChevronLeft, ChevronRight, ZoomIn, ZoomOut, Download, ExternalLink,
    Grid, X, Search, Loader, AlertTriangle
} from 'lucide-react';

// Setup for PDF.js worker. This is necessary for react-pdf to work correctly.
pdfjs.GlobalWorkerOptions.workerSrc = `https://esm.sh/pdfjs-dist@${pdfjs.version}/build/pdf.worker.mjs`;

// Augment the Window interface to include custom properties
declare global {
  interface Window {
    C42_SDK?: {
      request: (event: string, payload: any) => Promise<{ text?: string }>;
    };
    reactApp?: {
      loadPaper: (paperId: string) => void;
    };
  }
}

// --- ThumbnailItem Component (Lazy Loading) ---
interface ThumbnailItemProps {
  pdfDoc: PDFDocumentProxy;
  pageNumber: number;
  currentPage: number;
  onClick: () => void;
}

const ThumbnailItem: React.FC<ThumbnailItemProps> = ({ pdfDoc, pageNumber, currentPage, onClick }) => {
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);
  const placeholderRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Reset thumbnail when pdfDoc changes
    setThumbUrl(null);
  }, [pdfDoc]);

  useEffect(() => {
    if (!thumbUrl && placeholderRef.current) {
      const observer = new IntersectionObserver(
        (entries) => {
          if (entries[0].isIntersecting) {
            observer.disconnect();
            pdfDoc.getPage(pageNumber).then(page => {
              const viewport = page.getViewport({ scale: 150 / page.getViewport({ scale: 1.0 }).width });
              const canvas = document.createElement('canvas');
              const context = canvas.getContext('2d');
              if (!context) return;
              canvas.height = viewport.height;
              canvas.width = viewport.width;

              page.render({ canvasContext: context, viewport: viewport }).promise.then(() => {
                setThumbUrl(canvas.toDataURL('image/jpeg', 0.8));
              });
            }).catch(e => console.error(`Failed to render thumbnail for page ${pageNumber}`, e));
          }
        },
        { rootMargin: '100px' }
      );
      
      observer.observe(placeholderRef.current);
      return () => observer.disconnect();
    }
  }, [pdfDoc, pageNumber, thumbUrl]);

  return (
    <div
      ref={placeholderRef}
      onClick={onClick}
      className={`cursor-pointer rounded-md overflow-hidden ring-2 transition-all ${currentPage === pageNumber ? 'ring-purple-600 ring-offset-2 ring-offset-gray-100 dark:ring-offset-black' : 'ring-transparent hover:ring-purple-400'}`}
      style={{ aspectRatio: '0.707' }}
      aria-current={currentPage === pageNumber ? 'page' : undefined}
    >
      {thumbUrl ? (
        <img src={thumbUrl} alt={`Page ${pageNumber}`} className="w-full h-auto block" />
      ) : (
        <div className="w-full h-full bg-gray-200 dark:bg-gray-900 flex items-center justify-center">
            <Loader className="w-6 h-6 text-gray-400 animate-spin" />
        </div>
      )}
      <p className="text-center text-xs bg-gray-200 dark:bg-gray-800 text-gray-800 dark:text-gray-200 py-0.5">{pageNumber}</p>
    </div>
  );
};

// --- Smart Search Utility ---
const findRelevantChunks = (fullText: string, query: string, maxChars: number = 8000): string => {
    const queryWords = new Set(query.toLowerCase().split(/\s+/).filter(w => w.length > 2));
    if (queryWords.size === 0) return fullText.slice(0, maxChars);
    
    const paragraphs = fullText.split(/\n\s*\n/);
    const scoredParagraphs = paragraphs.map(p => {
        const lowerCaseParagraph = p.toLowerCase();
        let score = 0;
        queryWords.forEach(word => {
            if (lowerCaseParagraph.includes(word)) score++;
        });
        return { text: p, score };
    }).filter(p => p.score > 0);

    scoredParagraphs.sort((a, b) => b.score - a.score);
    
    let context = '';
    for (const p of scoredParagraphs) {
        if (context.length + p.text.length > maxChars) break;
        context += p.text + '\n\n';
    }
    return context.trim() || fullText.slice(0, maxChars);
};

// --- PDF Viewer Component ---
interface PDFViewerProps {
  fileUrl: string;
  className?: string;
}

const PDFViewer: React.FC<PDFViewerProps> = ({ fileUrl, className = '' }) => {
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [totalPages, setTotalPages] = useState<number>(0);
  const [scale, setScale] = useState<number>(100);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string>('');
  const [pageWidth, setPageWidth] = useState<number>(0);
  
  const [showThumbnails, setShowThumbnails] = useState<boolean>(true);
  const [showSearchPanel, setShowSearchPanel] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchIsLoading, setSearchIsLoading] = useState(false);
  const [searchStatus, setSearchStatus] = useState('');
  const [searchResult, setSearchResult] = useState('');
  const [searchError, setSearchError] = useState('');
  const [fullPdfText, setFullPdfText] = useState<string | null>(null);

  const viewerContainerRef = useRef<HTMLDivElement>(null);
  const C42_SDK = window.C42_SDK;
  const isSDKAvailable = C42_SDK && typeof C42_SDK.request === 'function';

  const onDocumentLoadSuccess = useCallback((doc: PDFDocumentProxy) => {
    setPdfDoc(doc);
    setTotalPages(doc.numPages);
    setCurrentPage(1);
    setIsLoading(false);
    setError('');
    // Reset search state for new document
    setFullPdfText(null);
    setSearchResult('');
    setSearchError('');
    setSearchQuery('');
  }, []);

  const onDocumentLoadError = useCallback((e: Error) => {
    console.error('Failed to load PDF:', e);
    setError(`Failed to load PDF: ${e.message}. Please ensure the file is accessible and not corrupted.`);
    setIsLoading(false);
  }, []);
  
  const onPageLoadSuccess = useCallback((page: PageProxy) => {
    setPageWidth(page.width);
  }, []);

  useEffect(() => {
    setIsLoading(true);
    setPdfDoc(null);
  }, [fileUrl]);

  const goToPage = (page: number) => {
    const newPage = Math.max(1, Math.min(totalPages, page));
    setCurrentPage(newPage);
  };

  const zoomIn = () => setScale(prev => Math.min(300, prev + 25));
  const zoomOut = () => setScale(prev => Math.max(25, prev - 25));

  const fitToWidth = useCallback(() => {
    if (!viewerContainerRef.current || !pageWidth) return;
    const containerWidth = viewerContainerRef.current.clientWidth;
    if (containerWidth > 0) {
      const newScale = (containerWidth / pageWidth) * 100 * 0.98; // 2% padding
      setScale(newScale);
    }
  }, [pageWidth]);

  useEffect(() => {
    fitToWidth();
    const viewerElement = viewerContainerRef.current;
    if (!viewerElement) return;
    const observer = new ResizeObserver(fitToWidth);
    observer.observe(viewerElement);
    return () => observer.disconnect();
  }, [fitToWidth]);

  const downloadPDF = () => {
    const link = document.createElement('a');
    link.href = fileUrl;
    link.download = fileUrl.split('/').pop() || 'document.pdf';
    link.target = '_blank';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };
  
  const openInNewTab = () => window.open(fileUrl, '_blank');

  const handleSmartSearch = async () => {
    if (!searchQuery.trim() || !pdfDoc || !isSDKAvailable) return;
    setSearchIsLoading(true);
    setSearchError('');
    setSearchResult('');
    try {
      let textContent = fullPdfText;
      if (!textContent) {
        setSearchStatus('Analyzing document...');
        const textPromises = Array.from({ length: pdfDoc.numPages }, (_, i) => 
          pdfDoc.getPage(i + 1).then(page => page.getTextContent())
        );
        const allTextContents = await Promise.all(textPromises);
        textContent = allTextContents.map(tc => tc.items.map(item => ('str' in item ? item.str : '')).join(' ')).join('\n');
        setFullPdfText(textContent);
      }
      setSearchStatus('Finding relevant sections...');
      const relevantText = findRelevantChunks(textContent, searchQuery);
      setSearchStatus('Asking the C42 Kernel...');
      const prompt = `You are an AI research assistant. Your task is to answer questions based *only* on the provided text from a PDF document. Do not use any external knowledge. If the answer cannot be found in the text, state that the information is not present in the document.\n\n--- DOCUMENT TEXT ---\n\n${relevantText}\n\n--- END DOCUMENT TEXT ---\n\nQuestion: ${searchQuery}`;
      const response = await C42_SDK.request('generate_response', { topic: prompt });
      if (response && response.text) setSearchResult(response.text);
      else setSearchError('Received an empty response from the host OS.');
    } catch(e) {
      const message = e instanceof Error ? e.message : 'An unknown error occurred';
      setSearchError(message || 'An error occurred while communicating with the host OS.');
    } finally {
      setSearchIsLoading(false);
      setSearchStatus('');
    }
  };

  const loadingOrErrorDisplay = (
    <div className={`bg-white dark:bg-c42-dark-card rounded-lg p-8 text-center flex flex-col items-center justify-center h-full ${className}`}>
      {isLoading ? (
        <>
          <Loader className="w-12 h-12 text-purple-600 animate-spin mx-auto mb-4" />
          <p className="text-gray-500 dark:text-gray-400">Loading PDF...</p>
        </>
      ) : (
        <div className="text-red-500 dark:text-c42-danger mb-4 max-w-2xl mx-auto">
          <AlertTriangle className="w-12 h-12 mx-auto mb-4"/>
          <p className="text-lg font-semibold">Error Loading Document</p>
          <div className="text-sm text-gray-700 dark:text-gray-300 mt-2 text-left bg-red-500/10 dark:bg-red-900/20 p-4 rounded-md border border-red-500/20 dark:border-red-900/30">
             <p className="font-bold mb-2">Technical Details:</p>{error}
          </div>
          <button onClick={openInNewTab} className="mt-6 px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors">Attempt to Open in New Tab</button>
        </div>
      )}
    </div>
  );

  if (isLoading || error) return loadingOrErrorDisplay;

  return (
    <div className={`bg-white dark:bg-c42-dark-card rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden flex flex-col h-full ${className}`}>
      <div className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 p-2">
        <div className="flex items-center justify-center md:justify-between flex-wrap gap-y-4 gap-x-2">
          <div className="flex items-center space-x-2">
            <button onClick={() => goToPage(currentPage - 1)} disabled={currentPage <= 1} className="p-2 rounded-md bg-gray-200 hover:bg-gray-300 dark:bg-gray-700 dark:hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors" aria-label="Previous page"><ChevronLeft className="w-4 h-4 text-gray-900 dark:text-gray-100"/></button>
            <div className="flex items-center space-x-2">
              <input type="number" value={currentPage} onChange={(e) => goToPage(parseInt(e.target.value) || 1)} className="w-16 px-2 py-1 text-center border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100" min="1" max={totalPages} aria-label={`Current page, ${currentPage} of ${totalPages}`} />
              <span className="text-sm text-gray-600 dark:text-gray-400">of {totalPages || '...'}</span>
            </div>
            <button onClick={() => goToPage(currentPage + 1)} disabled={currentPage >= totalPages} className="p-2 rounded-md bg-gray-200 hover:bg-gray-300 dark:bg-gray-700 dark:hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors" aria-label="Next page"><ChevronRight className="w-4 h-4 text-gray-900 dark:text-gray-100" /></button>
          </div>
          <div className="flex items-center space-x-2">
            <button onClick={zoomOut} className="p-2 rounded-md bg-gray-200 hover:bg-gray-300 dark:bg-gray-700 dark:hover:bg-gray-600 transition-colors" aria-label="Zoom out"><ZoomOut className="w-4 h-4 text-gray-900 dark:text-gray-100" /></button>
            <span className="text-sm text-gray-600 dark:text-gray-400 w-16 text-center">{Math.round(scale)}%</span>
            <button onClick={zoomIn} className="p-2 rounded-md bg-gray-200 hover:bg-gray-300 dark:bg-gray-700 dark:hover:bg-gray-600 transition-colors" aria-label="Zoom in"><ZoomIn className="w-4 h-4 text-gray-900 dark:text-gray-100" /></button>
            <button onClick={fitToWidth} className="px-3 py-1 text-sm bg-gray-200 hover:bg-gray-300 dark:bg-gray-700 dark:hover:bg-gray-600 rounded-md transition-colors text-gray-900 dark:text-gray-100">Fit</button>
          </div>
          <div className="flex items-center space-x-2">
            <button onClick={() => setShowThumbnails(!showThumbnails)} className={`p-2 rounded-md transition-colors ${showThumbnails ? 'bg-purple-600 text-white' : 'bg-gray-200 hover:bg-gray-300 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-900 dark:text-gray-100'}`} aria-label="Toggle Thumbnails"><Grid className="w-4 h-4"/></button>
            <button onClick={openInNewTab} className="p-2 rounded-md bg-gray-200 hover:bg-gray-300 dark:bg-gray-700 dark:hover:bg-gray-600 transition-colors" aria-label="Open in new tab"><ExternalLink className="w-4 h-4 text-gray-900 dark:text-gray-100" /></button>
            <button onClick={downloadPDF} className="p-2 rounded-md bg-gray-200 hover:bg-gray-300 dark:bg-gray-700 dark:hover:bg-gray-600 transition-colors" aria-label="Download PDF"><Download className="w-4 h-4 text-gray-900 dark:text-gray-100" /></button>
            <button onClick={() => setShowSearchPanel(!showSearchPanel)} className={`p-2 rounded-md transition-colors ${showSearchPanel ? 'bg-purple-600 text-white' : 'bg-gray-200 hover:bg-gray-300 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-900 dark:text-gray-100'}`} aria-label="Toggle Smart Search"><Search className="w-4 h-4" /></button>
          </div>
        </div>
      </div>
      <div className="flex flex-1 h-full min-h-0">
        {showThumbnails && pdfDoc && (
            <div className="w-48 bg-gray-100 dark:bg-black border-r border-gray-200 dark:border-gray-700 flex flex-col">
                <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 p-2 border-b border-gray-200 dark:border-gray-700 text-center sticky top-0 bg-gray-100 dark:bg-black z-10">Thumbnails</h3>
                <div className="flex-1 overflow-y-auto p-2 space-y-2">
                    {Array.from({ length: totalPages }, (_, i) => i + 1).map(pageNumber => (
                        <ThumbnailItem key={`thumb-${fileUrl}-${pageNumber}`} pdfDoc={pdfDoc} pageNumber={pageNumber} currentPage={currentPage} onClick={() => goToPage(pageNumber)}/>
                    ))}
                </div>
            </div>
        )}
        <div ref={viewerContainerRef} className="flex-1 bg-gray-200 dark:bg-black relative overflow-auto flex justify-center items-start p-4">
          <Document file={fileUrl} onLoadSuccess={onDocumentLoadSuccess} onLoadError={onDocumentLoadError} loading="">
             {totalPages > 0 && <Page pageNumber={currentPage} scale={scale / 100} onLoadSuccess={onPageLoadSuccess} className="flex justify-center" renderAnnotationLayer={true} renderTextLayer={true}/>}
          </Document>
        </div>
        {showSearchPanel && (
          <div className="p-4 overflow-y-auto flex flex-col fixed inset-0 z-30 bg-gray-50 dark:bg-gray-800 lg:relative lg:inset-auto lg:z-auto lg:w-80 lg:border-l lg:border-gray-200 lg:dark:border-gray-700">
             <div className="flex justify-between items-center mb-3">
                <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Smart Search</h3>
                <button onClick={() => setShowSearchPanel(false)} className="lg:hidden p-2 -mr-2 rounded-md text-gray-500 hover:bg-gray-200 dark:text-gray-400 dark:hover:bg-gray-700" aria-label="Close search panel"><X className="h-6 w-6" /></button>
             </div>
            <div className="flex-1 flex flex-col gap-4">
                <textarea value={searchQuery} onChange={e => setSearchQuery(e.target.value)} rows={4} className="w-full p-2 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 resize-none" placeholder="Ask a question about the document..."></textarea>
                <button onClick={handleSmartSearch} disabled={searchIsLoading || !searchQuery.trim() || !isSDKAvailable} className="w-full px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:bg-opacity-50 disabled:cursor-not-allowed transition-colors" title={!isSDKAvailable ? 'Smart Search is only available in C42 OS' : 'Ask AI'}>Ask AI</button>
                {searchIsLoading && (<div className="text-center text-sm text-gray-500 dark:text-gray-400 py-4"><Loader className="animate-spin rounded-full h-6 w-6 border-b-2 border-purple-600 mx-auto mb-2" /><p>{searchStatus}</p></div>)}
                {searchError && <div className="text-sm text-red-500 bg-red-500/10 p-2 rounded">{searchError}</div>}
                {searchResult && (
                    <div className="flex-1 min-h-0 flex flex-col"><p className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">Answer:</p><div className="text-sm bg-white dark:bg-gray-900 p-3 rounded-md border border-gray-200 dark:border-gray-700 h-full overflow-y-auto whitespace-pre-wrap text-gray-700 dark:text-gray-300">{searchResult}</div></div>
                )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

// --- App Bootstrap ---
const paperUrls: { [key: string]: string } = {
    'meta-symbolic-language': './towards-a-universal-meta-symbolic-language.pdf',
    'symbolic-languages': './universal-symbolic-languages-bridging-human-cognition-and-ai-consciousness.pdf',
};

const App = () => {
    const [fileUrl, setFileUrl] = useState<string>(paperUrls['meta-symbolic-language']);
    useEffect(() => {
        window.reactApp = { loadPaper: (paperId) => { if (paperUrls[paperId]) setFileUrl(paperUrls[paperId]); } };
        return () => { delete window.reactApp; };
    }, []);
    return <PDFViewer fileUrl={fileUrl} className="h-full" />;
};

const container = document.getElementById('pdfViewerContainer');
if (container) {
    createRoot(container).render(<App />);
} else {
    console.error('Fatal Error: Could not find the root container #pdfViewerContainer to mount the React app.');
}
