import { describe, it, expect } from 'vitest'
import {
  extractLabels,
  extractRefs,
  extractCitations,
  extractBibResources,
} from '../../../../app/js/util/latex-refs.js'

describe('latex-refs.js', () => {
  describe('extractLabels', () => {
    it('extracts a single label', () => {
      const content = '\\label{fig:example}'
      const results = extractLabels(content, 'main.tex')
      expect(results).toHaveLength(1)
      expect(results[0].key).toBe('fig:example')
      expect(results[0].file).toBe('main.tex')
      expect(results[0].line).toBe(1)
    })

    it('extracts multiple labels', () => {
      const content = [
        '\\section{Intro}',
        '\\label{sec:intro}',
        'Some text.',
        '\\label{eq:main}',
      ].join('\n')
      const results = extractLabels(content, 'main.tex')
      expect(results).toHaveLength(2)
      expect(results[0].key).toBe('sec:intro')
      expect(results[0].line).toBe(2)
      expect(results[1].key).toBe('eq:main')
      expect(results[1].line).toBe(4)
    })

    it('excludes commented-out labels', () => {
      const content = [
        '% \\label{commented}',
        '\\label{real}',
        '  % old: \\label{also_commented}',
      ].join('\n')
      const results = extractLabels(content, 'test.tex')
      expect(results).toHaveLength(1)
      expect(results[0].key).toBe('real')
    })

    it('returns empty array when no labels', () => {
      const content = '\\section{No labels here}\nJust text.'
      const results = extractLabels(content, 'empty.tex')
      expect(results).toHaveLength(0)
    })

    it('handles labels with colons and underscores', () => {
      const content = '\\label{sec:my_section_1}'
      const results = extractLabels(content, 'test.tex')
      expect(results).toHaveLength(1)
      expect(results[0].key).toBe('sec:my_section_1')
    })
  })

  describe('extractRefs', () => {
    it('extracts \\ref commands', () => {
      const content = 'See Figure \\ref{fig:diagram}.'
      const results = extractRefs(content, 'main.tex')
      expect(results).toHaveLength(1)
      expect(results[0].key).toBe('fig:diagram')
      expect(results[0].command).toBe('ref')
    })

    it('extracts \\eqref commands', () => {
      const content = 'As shown in \\eqref{eq:energy}.'
      const results = extractRefs(content, 'main.tex')
      expect(results).toHaveLength(1)
      expect(results[0].key).toBe('eq:energy')
      expect(results[0].command).toBe('eqref')
    })

    it('extracts \\autoref commands', () => {
      const content = '\\autoref{tab:results}'
      const results = extractRefs(content, 'main.tex')
      expect(results).toHaveLength(1)
      expect(results[0].key).toBe('tab:results')
      expect(results[0].command).toBe('autoref')
    })

    it('extracts \\cref commands', () => {
      const content = '\\cref{sec:intro}'
      const results = extractRefs(content, 'main.tex')
      expect(results).toHaveLength(1)
      expect(results[0].command).toBe('cref')
    })

    it('extracts \\Cref commands', () => {
      const content = '\\Cref{sec:methods}'
      const results = extractRefs(content, 'main.tex')
      expect(results).toHaveLength(1)
      expect(results[0].command).toBe('Cref')
    })

    it('extracts \\pageref commands', () => {
      const content = 'on page \\pageref{sec:results}'
      const results = extractRefs(content, 'main.tex')
      expect(results).toHaveLength(1)
      expect(results[0].command).toBe('pageref')
    })

    it('extracts multiple different ref types from same content', () => {
      const content = [
        'See \\ref{fig:a} and \\eqref{eq:b}.',
        'Also \\autoref{tab:c} and \\cref{sec:d}.',
      ].join('\n')
      const results = extractRefs(content, 'main.tex')
      expect(results).toHaveLength(4)
      expect(results.map(r => r.command)).toEqual(['ref', 'eqref', 'autoref', 'cref'])
    })

    it('excludes commented-out refs', () => {
      const content = [
        '% \\ref{commented}',
        '\\ref{real}',
      ].join('\n')
      const results = extractRefs(content, 'main.tex')
      expect(results).toHaveLength(1)
      expect(results[0].key).toBe('real')
    })

    it('reports correct line numbers', () => {
      const content = [
        'First line.',
        'Second \\ref{sec:a}.',
        'Third line.',
        'Fourth \\ref{sec:b}.',
      ].join('\n')
      const results = extractRefs(content, 'main.tex')
      expect(results).toHaveLength(2)
      expect(results[0].line).toBe(2)
      expect(results[1].line).toBe(4)
    })

    it('returns empty array when no refs', () => {
      const content = '\\section{No refs}\nJust text.'
      const results = extractRefs(content, 'test.tex')
      expect(results).toHaveLength(0)
    })
  })

  describe('extractCitations', () => {
    it('extracts \\cite commands', () => {
      const content = '\\cite{Smith2020}'
      const results = extractCitations(content, 'main.tex')
      expect(results).toHaveLength(1)
      expect(results[0].keys).toEqual(['Smith2020'])
      expect(results[0].command).toBe('cite')
    })

    it('extracts \\citep commands', () => {
      const content = '\\citep{Jones2019}'
      const results = extractCitations(content, 'main.tex')
      expect(results).toHaveLength(1)
      expect(results[0].keys).toEqual(['Jones2019'])
      expect(results[0].command).toBe('citep')
    })

    it('extracts \\citet commands', () => {
      const content = '\\citet{Brown2021}'
      const results = extractCitations(content, 'main.tex')
      expect(results).toHaveLength(1)
      expect(results[0].command).toBe('citet')
    })

    it('extracts \\citealp commands', () => {
      const content = '\\citealp{Davis2020}'
      const results = extractCitations(content, 'main.tex')
      expect(results).toHaveLength(1)
      expect(results[0].command).toBe('citealp')
    })

    it('extracts starred variants like \\cite*', () => {
      const content = '\\cite*{Key2020}'
      const results = extractCitations(content, 'main.tex')
      expect(results).toHaveLength(1)
      expect(results[0].keys).toEqual(['Key2020'])
    })

    it('handles comma-separated keys', () => {
      const content = '\\cite{Alpha2020, Beta2021, Gamma2022}'
      const results = extractCitations(content, 'main.tex')
      expect(results).toHaveLength(1)
      expect(results[0].keys).toEqual(['Alpha2020', 'Beta2021', 'Gamma2022'])
    })

    it('extracts \\parencite commands', () => {
      const content = '\\parencite{Ref2020}'
      const results = extractCitations(content, 'main.tex')
      expect(results).toHaveLength(1)
      expect(results[0].command).toBe('parencite')
    })

    it('extracts \\textcite commands', () => {
      const content = '\\textcite{Ref2020}'
      const results = extractCitations(content, 'main.tex')
      expect(results).toHaveLength(1)
      expect(results[0].command).toBe('textcite')
    })

    it('extracts \\autocite commands', () => {
      const content = '\\autocite{Ref2020}'
      const results = extractCitations(content, 'main.tex')
      expect(results).toHaveLength(1)
      expect(results[0].command).toBe('autocite')
    })

    it('extracts multiple citations across lines', () => {
      const content = [
        'First \\cite{A}.',
        'Second \\citep{B, C}.',
        'Third \\citet{D}.',
      ].join('\n')
      const results = extractCitations(content, 'main.tex')
      expect(results).toHaveLength(3)
      expect(results[0].keys).toEqual(['A'])
      expect(results[1].keys).toEqual(['B', 'C'])
      expect(results[2].keys).toEqual(['D'])
    })

    it('excludes commented-out citations', () => {
      const content = [
        '% \\cite{commented}',
        '\\cite{real}',
      ].join('\n')
      const results = extractCitations(content, 'main.tex')
      expect(results).toHaveLength(1)
      expect(results[0].keys).toEqual(['real'])
    })

    it('reports correct line numbers', () => {
      const content = [
        'Line one.',
        '\\cite{Key1}',
        'Line three.',
        '\\citep{Key2}',
      ].join('\n')
      const results = extractCitations(content, 'main.tex')
      expect(results[0].line).toBe(2)
      expect(results[1].line).toBe(4)
    })

    it('returns empty array when no citations', () => {
      const content = '\\section{No cites}\nJust text.'
      const results = extractCitations(content, 'test.tex')
      expect(results).toHaveLength(0)
    })
  })

  describe('extractBibResources', () => {
    it('extracts \\bibliography command', () => {
      const content = '\\bibliography{references}'
      const results = extractBibResources(content, 'main.tex')
      expect(results).toHaveLength(1)
      expect(results[0].path).toBe('references')
      expect(results[0].command).toBe('bibliography')
      expect(results[0].file).toBe('main.tex')
      expect(results[0].line).toBe(1)
    })

    it('extracts \\addbibresource command', () => {
      const content = '\\addbibresource{refs.bib}'
      const results = extractBibResources(content, 'main.tex')
      expect(results).toHaveLength(1)
      expect(results[0].path).toBe('refs.bib')
      expect(results[0].command).toBe('addbibresource')
    })

    it('extracts multiple bib resources', () => {
      const content = [
        '\\addbibresource{main.bib}',
        '\\addbibresource{extra.bib}',
      ].join('\n')
      const results = extractBibResources(content, 'main.tex')
      expect(results).toHaveLength(2)
      expect(results[0].path).toBe('main.bib')
      expect(results[1].path).toBe('extra.bib')
    })

    it('excludes commented-out bib resources', () => {
      const content = [
        '% \\bibliography{old}',
        '\\bibliography{current}',
      ].join('\n')
      const results = extractBibResources(content, 'main.tex')
      expect(results).toHaveLength(1)
      expect(results[0].path).toBe('current')
    })

    it('trims whitespace from path', () => {
      const content = '\\bibliography{  refs  }'
      const results = extractBibResources(content, 'main.tex')
      expect(results).toHaveLength(1)
      expect(results[0].path).toBe('refs')
    })

    it('reports correct line numbers', () => {
      const content = [
        '\\documentclass{article}',
        '\\usepackage{biblatex}',
        '\\addbibresource{refs.bib}',
      ].join('\n')
      const results = extractBibResources(content, 'main.tex')
      expect(results).toHaveLength(1)
      expect(results[0].line).toBe(3)
    })

    it('returns empty array when no bib resources', () => {
      const content = '\\section{Hello}\nNo bibliography.'
      const results = extractBibResources(content, 'test.tex')
      expect(results).toHaveLength(0)
    })

    it('handles \\addbibresource with optional argument', () => {
      const content = '\\addbibresource[datatype=bibtex]{refs.bib}'
      const results = extractBibResources(content, 'main.tex')
      expect(results).toHaveLength(1)
      expect(results[0].path).toBe('refs.bib')
      expect(results[0].command).toBe('addbibresource')
    })
  })

  describe('extractCitations — optional arguments (Codex review)', () => {
    it('handles \\citep with one optional argument', () => {
      const content = '\\citep[p.~42]{Smith2020}'
      const results = extractCitations(content, 'main.tex')
      expect(results).toHaveLength(1)
      expect(results[0].keys).toEqual(['Smith2020'])
      expect(results[0].command).toBe('citep')
    })

    it('handles \\citep with two optional arguments', () => {
      const content = '\\citep[see][p.~3]{Smith2020}'
      const results = extractCitations(content, 'main.tex')
      expect(results).toHaveLength(1)
      expect(results[0].keys).toEqual(['Smith2020'])
    })

    it('handles \\textcite with optional argument', () => {
      const content = '\\textcite[Chapter 2]{Jones2019}'
      const results = extractCitations(content, 'main.tex')
      expect(results).toHaveLength(1)
      expect(results[0].keys).toEqual(['Jones2019'])
    })
  })

  describe('extractRefs — cref multi-key (Codex review)', () => {
    it('splits \\cref with comma-separated keys', () => {
      const content = '\\cref{fig:a,fig:b,fig:c}'
      const results = extractRefs(content, 'main.tex')
      expect(results).toHaveLength(3)
      expect(results.map(r => r.key)).toEqual(['fig:a', 'fig:b', 'fig:c'])
      expect(results[0].command).toBe('cref')
    })

    it('splits \\Cref with comma-separated keys', () => {
      const content = '\\Cref{tab:a,tab:b}'
      const results = extractRefs(content, 'main.tex')
      expect(results).toHaveLength(2)
      expect(results.map(r => r.key)).toEqual(['tab:a', 'tab:b'])
    })

    it('does not split \\ref keys (single key expected)', () => {
      const content = '\\ref{fig:single}'
      const results = extractRefs(content, 'main.tex')
      expect(results).toHaveLength(1)
      expect(results[0].key).toBe('fig:single')
    })
  })

  describe('whitespace tolerance (Codex round 2)', () => {
    it('extracts \\label with space before brace', () => {
      const content = '\\label {fig:spaced}'
      const results = extractLabels(content, 'main.tex')
      expect(results).toHaveLength(1)
      expect(results[0].key).toBe('fig:spaced')
    })

    it('extracts \\ref with space before brace', () => {
      const content = '\\ref {fig:spaced}'
      const results = extractRefs(content, 'main.tex')
      expect(results).toHaveLength(1)
      expect(results[0].key).toBe('fig:spaced')
    })

    it('extracts \\cite with space before brace', () => {
      const content = '\\cite {Smith2020}'
      const results = extractCitations(content, 'main.tex')
      expect(results).toHaveLength(1)
      expect(results[0].keys).toEqual(['Smith2020'])
    })

    it('extracts \\bibliography with space before brace', () => {
      const content = '\\bibliography {refs}'
      const results = extractBibResources(content, 'main.tex')
      expect(results).toHaveLength(1)
      expect(results[0].path).toBe('refs')
    })
  })

  describe('verbatim exclusion (Codex round 2)', () => {
    it('excludes \\label inside verbatim environment', () => {
      const content = [
        '\\label{real}',
        '\\begin{verbatim}',
        '\\label{inside_verbatim}',
        '\\end{verbatim}',
      ].join('\n')
      const results = extractLabels(content, 'main.tex')
      expect(results).toHaveLength(1)
      expect(results[0].key).toBe('real')
    })

    it('excludes \\ref inside lstlisting environment', () => {
      const content = [
        '\\ref{real}',
        '\\begin{lstlisting}',
        '\\ref{inside_listing}',
        '\\end{lstlisting}',
      ].join('\n')
      const results = extractRefs(content, 'main.tex')
      expect(results).toHaveLength(1)
      expect(results[0].key).toBe('real')
    })

    it('excludes \\cite inside minted environment', () => {
      const content = [
        '\\cite{real}',
        '\\begin{minted}{python}',
        '\\cite{inside_minted}',
        '\\end{minted}',
      ].join('\n')
      const results = extractCitations(content, 'main.tex')
      expect(results).toHaveLength(1)
      expect(results[0].keys).toEqual(['real'])
    })
  })

  describe('isCommented — escaped percent (Codex review)', () => {
    it('does not treat \\% as a comment', () => {
      const content = 'Revenue increased by 50\\% \\cite{Data2020}'
      const results = extractCitations(content, 'main.tex')
      expect(results).toHaveLength(1)
      expect(results[0].keys).toEqual(['Data2020'])
    })

    it('treats unescaped % as a comment', () => {
      const content = 'Text % \\cite{Commented2020}'
      const results = extractCitations(content, 'main.tex')
      expect(results).toHaveLength(0)
    })

    it('does not extract label after \\% in inline text', () => {
      const content = '50\\% \\label{fig:valid}'
      const results = extractLabels(content, 'main.tex')
      expect(results).toHaveLength(1)
      expect(results[0].key).toBe('fig:valid')
    })

    it('skips label after real comment with preceding \\%', () => {
      const content = '50\\%% this is a real comment \\label{fig:bad}'
      const results = extractLabels(content, 'main.tex')
      // The second % is unescaped, so it's a real comment
      expect(results).toHaveLength(0)
    })
  })
})
