<script lang="ts">
	import ChatFormActions from '$lib/components/app/chat/ChatForm/ChatFormActions/ChatFormActions.svelte';
	import * as Tooltip from '$lib/components/ui/tooltip';

	let { disabled = false }: { disabled?: boolean } = $props();
</script>

<Tooltip.Provider>
	<ChatFormActions {disabled} />
</Tooltip.Provider>
