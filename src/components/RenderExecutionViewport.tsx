import React, { useState, useRef, useCallback, memo } from 'react';

interface RenderExecutionProps {
  trackTitle: string;
  totalBlocks: number;
  tokenValue: number;
  /** Executes a single block of the pipeline. Defaults to a no-op pacing step. */
  onExecuteBlock?: (blockIndex: number) => Promise<void>;
}

type RenderState = 'idle' | 'rendering' | 'error' | 'success';

export const RenderExecutionViewport: React.FC<RenderExecutionProps> = memo(
  ({ trackTitle, totalBlocks, tokenValue, onExecuteBlock }) => {
    const [renderState, setRenderState] = useState<RenderState>('idle');
    const [activeBlock, setActiveBlock] = useState<number>(0);
    const [errorMessage, setErrorMessage] = useState<string | null>(null);

    // Ref tracks execution across async calls without forcing re-mounts
    const isExecutingRef = useRef<boolean>(false);

    const executeRenderSequence = useCallback(async () => {
      if (isExecutingRef.current) return;
      isExecutingRef.current = true;
      setRenderState('rendering');
      setErrorMessage(null);

      try {
        for (let i = 1; i <= totalBlocks; i++) {
          setActiveBlock(i);
          if (onExecuteBlock) {
            await onExecuteBlock(i);
          } else {
            await new Promise((resolve) => setTimeout(resolve, 800));
          }
        }
        setRenderState('success');
      } catch (error) {
        setRenderState('error');
        setErrorMessage(
          error instanceof Error ? error.message : 'Pipeline execution failed.',
        );
      } finally {
        isExecutingRef.current = false;
      }
    }, [totalBlocks, onExecuteBlock]);

    return (
      <div className="p-6 bg-card text-foreground rounded-xl border border-border shadow-2xl">
        <div className="flex justify-between items-center mb-4 gap-4">
          <h3 className="text-xl font-bold tracking-tight text-primary">
            {trackTitle}
          </h3>
          <span className="text-sm px-3 py-1 bg-muted border border-border rounded-full text-muted-foreground whitespace-nowrap">
            State:{' '}
            <strong className="capitalize text-foreground">{renderState}</strong>
          </span>
        </div>

        <div className="space-y-3 mb-6 text-sm text-muted-foreground">
          <p>
            Target Revenue Rate:{' '}
            <strong className="text-foreground">
              ${tokenValue.toFixed(2)} / V token
            </strong>
          </p>
          <p>
            Execution Progress:{' '}
            <strong className="text-foreground">
              Block {activeBlock} of {totalBlocks}
            </strong>
          </p>
        </div>

        {errorMessage && (
          <div
            role="alert"
            className="mb-4 p-3 bg-destructive/15 border border-destructive/50 text-destructive-foreground rounded-lg text-sm"
          >
            {errorMessage}
          </div>
        )}

        <div className="flex gap-4">
          <button
            type="button"
            onClick={executeRenderSequence}
            disabled={renderState === 'rendering'}
            className="px-5 py-2.5 bg-primary hover:bg-primary/90 disabled:bg-muted disabled:text-muted-foreground font-semibold text-primary-foreground rounded-lg transition-colors cursor-pointer disabled:cursor-not-allowed"
          >
            {renderState === 'rendering'
              ? 'Executing Pipeline...'
              : `Start ${totalBlocks}-Block Render`}
          </button>
        </div>
      </div>
    );
  },
);

RenderExecutionViewport.displayName = 'RenderExecutionViewport';
