<template>
    <div class="file-tabs">
        <div v-for="(file, idx) in files" :key="file.uri" :class="['file-tab', { active: idx === activeIndex }]"
            @click="$emit('select', idx)">
            <span class="file-name">{{ file.name }}</span>
            <button v-if="files.length > 1" class="close-btn" @click.stop="$emit('close', idx)">&times;</button>
        </div>
        <button class="add-btn" @click="$emit('add')">+</button>
    </div>
</template>

<script setup lang="ts">
import { defineProps, defineEmits } from 'vue'

type FileTab = {
    name: string
    uri: string
    isDirty?: boolean
}

defineProps<{
    files: FileTab[]
    activeIndex: number
}>()

defineEmits(['select', 'add', 'close'])
</script>

<style scoped>
.file-tabs {
    display: flex;
    align-items: center;
    background: var(--panel-background);
    border-bottom: 1px solid var(--gutter);
    height: 36px;
    padding-left: 8px;
}

.file-tab {
    display: flex;
    align-items: center;
    padding: 0 12px;
    margin-right: 2px;
    height: 100%;
    cursor: pointer;
    background: transparent;
    border: none;
    border-radius: 6px 6px 0 0;
    color: var(--inactive-tab-title);
    transition: background 0.15s;
}

.file-tab.active {
    background: var(--code-editor-background);
    color: var(--white);
}

.file-name {
    margin-right: 6px;
}

.close-btn {
    background: none;
    border: none;
    color: #aaa;
    font-size: 14px;
    cursor: pointer;
    margin-left: 2px;
}

.close-btn:hover {
    color: #f55;
}

.add-btn {
    background: none;
    border: none;
    color: var(--white);
    font-size: 20px;
    margin-left: 8px;
    cursor: pointer;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    transition: background 0.15s;
}

.add-btn:hover {
    background: var(--gutter-hover);
}
</style>
