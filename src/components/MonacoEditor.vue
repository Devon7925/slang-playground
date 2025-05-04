<script setup lang="ts">
import { useTemplateRef, onMounted, ref, shallowRef, onUnmounted, watch } from 'vue'
import * as monaco from 'monaco-editor';
import { initLanguageServer, initMonaco, translateSeverity, userCodeURI } from '@/language-server';
import { compiler, slangd } from '@/try-slang';

const container = useTemplateRef('container')
const editor = shallowRef<monaco.editor.IStandaloneCodeEditor>();
let diagnosticTimeout: number | null = null;

const props = defineProps<{ file?: { name: string, uri: string, content: string }, readOnlyMode?: boolean }>()
const emit = defineEmits(['input'])

const modelMap = new Map<string, monaco.editor.ITextModel>()
let contentChangeDisposable: monaco.IDisposable | null = null

function setEditorValue(value: string, revealEnd: boolean = false) {
	if (!editor.value) return
	const model = editor.value.getModel()
	if (model) {
		model.setValue(value)
		if (revealEnd)
			editor.value.revealLine(model.getLineCount() || 0)
		else
			editor.value.revealLine(0)
	}
}

function appendEditorValue(value: string, revealEnd: boolean = false) {
	setEditorValue((editor.value?.getValue() ?? '') + value, revealEnd);
}

function getValue() {
	if (!editor.value) return ''
	return editor.value.getValue()
}

function setLanguage(language: string) {
	let model = editor.value?.getModel();
	if (model == null) {
		throw new Error("Could not get editor model");
	}
	monaco.editor.setModelLanguage(model, language);
}

defineExpose({
	setEditorValue,
	appendEditorValue,
	getValue,
	setLanguage,
})


onMounted(() => {
	const wordWrap = "off";
	if (container.value == null) {
		throw new Error("Could not find container for editor");
	}
	initMonaco();
	// Create or get model for the file
	let model: monaco.editor.ITextModel
	if (props.file) {
		const uri = monaco.Uri.parse(props.file.uri)
		model = monaco.editor.getModel(uri) || monaco.editor.createModel(props.file.content, 'slang', uri)
		modelMap.set(props.file.uri, model)
	} else {
		model = monaco.editor.createModel('', 'slang')
	}
	editor.value = monaco.editor.create(container.value, {
		model: model,
		language: props.readOnlyMode ? 'csharp' : 'slang',
		theme: 'slang-dark',
		readOnly: props.readOnlyMode,
		lineNumbers: props.readOnlyMode ? "off" : "on",
		automaticLayout: true,
		wordWrap: wordWrap,
		"semanticHighlighting.enabled": true,
		renderValidationDecorations: "on",
		minimap: {
			enabled: false
		},
	});
	if (!props.readOnlyMode && props.file) {
		if (contentChangeDisposable) contentChangeDisposable.dispose();
		contentChangeDisposable = model.onDidChangeContent(() => {
			emit('input', model.getValue())
		})
	}
})

// Watch for file prop changes and switch model

watch(() => props.file, (newFile, oldFile) => {
	if (!editor.value || !newFile) return
	let uri = monaco.Uri.parse(newFile.uri)
	let model = monaco.editor.getModel(uri)
	if (!model) {
		model = monaco.editor.createModel(newFile.content, 'slang', uri)
		modelMap.set(newFile.uri, model)
	} else {
		// Always sync model content to file content if different
		if (model.getValue() !== newFile.content) {
			model.setValue(newFile.content)
		}
	}
	editor.value.setModel(model)
	// Attach content change handler for the new model
	if (!props.readOnlyMode && newFile) {
		if (contentChangeDisposable) contentChangeDisposable.dispose();
		contentChangeDisposable = model.onDidChangeContent(() => {
			emit('input', model.getValue())
		})
	}
}, { immediate: true })


onUnmounted(() => {
	if (contentChangeDisposable) contentChangeDisposable.dispose();
	if (editor.value != null) {
		editor.value.getModel()?.dispose();
		editor.value.dispose();
	}
})

function codeEditorChangeContent(e: monaco.editor.IModelContentChangedEvent) {
	if (slangd == null)
		return;
	if (compiler == null) {
		throw new Error("Compiler is undefined!");
	}
	let lspChanges = new compiler.slangWasmModule.TextEditList();

	e.changes.forEach(change =>
		lspChanges.push_back(
			{
				range: {
					start: { line: change.range.startLineNumber - 1, character: change.range.startColumn - 1 },
					end: { line: change.range.endLineNumber - 1, character: change.range.endColumn - 1 }
				},
				text: change.text
			}
		));
	try {
		// Use the current file's URI for diagnostics and LSP
		const uri = editor.value?.getModel()?.uri.toString() || userCodeURI;
		slangd.didChangeTextDocument(uri, lspChanges);
		if (diagnosticTimeout != null) {
			clearTimeout(diagnosticTimeout);
		}
		diagnosticTimeout = setTimeout(() => {
			if (slangd == null) {
				throw new Error("Slang is undefined!");
			}
			let diagnostics = slangd.getDiagnostics(uri);
			let model = editor.value?.getModel();
			if (model == null) {
				throw new Error("Could not get editor model");
			}
			if (diagnostics == null) {
				monaco.editor.setModelMarkers(model, "slang", []);
				return;
			}
			let markers: monaco.editor.IMarkerData[] = [];
			for (let i = 0; i < diagnostics.size(); i++) {
				let lspDiagnostic = diagnostics.get(i);
				if (lspDiagnostic == undefined) {
					throw new Error("Invalid state!");
				}
				markers.push({
					startLineNumber: lspDiagnostic.range.start.line + 1,
					startColumn: lspDiagnostic.range.start.character + 1,
					endLineNumber: lspDiagnostic.range.end.line + 1,
					endColumn: lspDiagnostic.range.end.character + 1,
					message: lspDiagnostic.message.toString(),
					severity: translateSeverity(lspDiagnostic.severity),
					code: lspDiagnostic.code.toString()
				});
			}
			monaco.editor.setModelMarkers(model, "slang", markers);
			diagnosticTimeout = null;
		}, 500);

	} catch (e) {
		console.error(e);
	}
	finally {
		lspChanges.delete();
	}
}
</script>

<template>
	<div class="editorContainer" ref="container"></div>
</template>

<style scoped>
.editorContainer {
	background-color: var(--panel-background);
	height: 100%;
}
</style>