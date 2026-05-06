import { Component } from 'react';

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    console.error('[ErrorBoundary] Caught:', error, info?.componentStack);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  isChunkLoadError() {
    const msg = this.state.error?.message || '';
    return (
      msg.includes('Failed to fetch dynamically imported module') ||
      msg.includes('Importing a module script failed') ||
      msg.includes('error loading dynamically imported module') ||
      this.state.error?.name === 'ChunkLoadError'
    );
  }

  render() {
    if (!this.state.hasError) return this.props.children;

    const { level = 'page' } = this.props;
    const isChunk = this.isChunkLoadError();
    const message = isChunk
      ? 'A new version has been deployed. Please reload to get the latest update.'
      : (this.state.error?.message || 'An unexpected error occurred');

    if (level === 'tab') {
      return (
        <div className="flex flex-col items-center justify-center py-20 px-6">
          <div className={`w-12 h-12 rounded-xl flex items-center justify-center mb-4 ${isChunk ? 'bg-ed-accent/10' : 'bg-ed-rust/10'}`}>
            {isChunk ? (
              <svg className="w-6 h-6 text-ed-accent" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182" />
              </svg>
            ) : (
              <svg className="w-6 h-6 text-ed-rust" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
              </svg>
            )}
          </div>
          <p className="font-serif text-[15px] font-[420] text-ed-ink mb-1">
            {isChunk ? 'Update Available' : 'Something went wrong'}
          </p>
          <p className="text-[13px] text-ed-ink2 mb-4 max-w-md text-center">{message}</p>
          <button
            onClick={() => window.location.reload()}
            className={isChunk
              ? 'px-4 py-2 rounded-[7px] text-[13px] bg-ed-accent text-white hover:bg-ed-accent/90 transition-colors'
              : 'ed-ghost text-[13px]'
            }
          >
            {isChunk ? 'Reload Page' : 'Try Again'}
          </button>
        </div>
      );
    }

    return (
      <div className="min-h-screen flex items-center justify-center bg-ed-bg">
        <div className="text-center px-6">
          <div className={`w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-5 ${isChunk ? 'bg-ed-accent/10' : 'bg-ed-rust/10'}`}>
            {isChunk ? (
              <svg className="w-8 h-8 text-ed-accent" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182" />
              </svg>
            ) : (
              <svg className="w-8 h-8 text-ed-rust" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
              </svg>
            )}
          </div>
          <h1 className="font-serif text-xl font-[420] text-ed-ink mb-2">
            {isChunk ? 'Update Available' : 'Something went wrong'}
          </h1>
          <p className="text-[14px] text-ed-ink2 mb-6 max-w-sm mx-auto">{message}</p>
          <div className="flex gap-3 justify-center">
            {!isChunk && (
              <button onClick={this.handleReset} className="ed-ghost text-[13px]">
                Try Again
              </button>
            )}
            <button
              onClick={() => window.location.reload()}
              className="px-4 py-2 rounded-[7px] text-[13px] bg-ed-accent text-white hover:bg-ed-accent/90 transition-colors"
            >
              Reload Page
            </button>
          </div>
        </div>
      </div>
    );
  }
}
