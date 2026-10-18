// Sibling-info correctness for buildSiblingInfoMap, including the memoized
// leaf resolution. A wrong leaf id here breaks branch navigation, so the
// deep-chain and multi-branch cases below pin the resolution down.

import { MessageRole, MessageType } from '$lib/enums';
import type { DatabaseMessage } from '$lib/types/database';
import { buildSiblingInfoMap, findCompactionGraftFixes, findLeafNode } from '$lib/utils/branching';
import { describe, expect, it } from 'vitest';

function msg(id: string, parent: string | null, children: string[] = []): DatabaseMessage {
	return {
		children,
		content: '',
		convId: 'c1',
		id,
		parent,
		role: MessageRole.USER,
		timestamp: 0,
		type: MessageType.TEXT
	} as DatabaseMessage;
}

/** Create a compaction message for graft-fix tests. */
function cmpMsg(id: string, parent: string | null): DatabaseMessage {
	return {
		children: [],
		compactionMeta: { firstKeptMessageId: 'x', summarizedCount: 1 },
		content: 'summary',
		convId: 'c1',
		id,
		parent,
		role: MessageRole.USER,
		timestamp: 0,
		type: MessageType.COMPACTION
	} as DatabaseMessage;
}

/** root -> m1 -> ... -> m depth, each node with a single child. */
function linearChain(depth: number): DatabaseMessage[] {
	const messages = [msg('m0', null, ['m1'])];

	for (let i = 1; i <= depth; i++) {
		messages.push(msg(`m${i}`, `m${i - 1}`, i < depth ? [`m${i + 1}`] : []));
	}

	return messages;
}

describe('buildSiblingInfoMap', () => {
	it('resolves the deepest leaf for every node of a long single chain', () => {
		const messages = linearChain(50);
		const map = buildSiblingInfoMap(messages);
		const leafId = messages[messages.length - 1].id;

		// every non-root message of the chain is an only child, and its
		// navigation target is the chain's deepest leaf
		for (const m of messages.slice(1)) {
			const info = map.get(m.id);

			expect(info?.totalSiblings).toBe(1);
			expect(info?.siblingIds).toEqual([leafId]);
		}
	});

	it('reports sibling position and leaf targets on a branched tree', () => {
		// m0 -> m1, m4 ; m1 -> m2 ; m2 -> m3, m6 ; m4 -> m5
		const root = msg('m0', null, ['m1', 'm4']);
		const m1 = msg('m1', 'm0', ['m2']);
		const m2 = msg('m2', 'm1', ['m3', 'm6']);
		const m3 = msg('m3', 'm2');
		const m4 = msg('m4', 'm0', ['m5']);
		const m5 = msg('m5', 'm4');
		const m6 = msg('m6', 'm2');
		const map = buildSiblingInfoMap([root, m1, m2, m3, m4, m5, m6]);

		// m1 and m4 share the root as parent; their nav targets are the
		// leaves of their subtrees ( m6 for the first branch, m5 for the second )
		expect(map.get(m1.id)).toMatchObject({
			currentIndex: 0,
			siblingIds: [m6.id, m5.id],
			totalSiblings: 2
		});
		expect(map.get(m4.id)).toMatchObject({
			currentIndex: 1,
			siblingIds: [m6.id, m5.id],
			totalSiblings: 2
		});

		// m3 and m6 are siblings under m2; both are leaves
		expect(map.get(m3.id)?.siblingIds).toEqual([m3.id, m6.id]);
		expect(map.get(m6.id)?.currentIndex).toBe(1);

		// the root has no parent and reports itself
		expect(map.get(root.id)).toMatchObject({
			currentIndex: 0,
			siblingIds: [root.id],
			totalSiblings: 1
		});
	});

	it('agrees with findLeafNode for arbitrary nodes', () => {
		const messages = linearChain(20);
		const leafId = messages[messages.length - 1].id;

		// every node of the chain resolves to the deepest leaf
		for (const m of messages) {
			expect(findLeafNode(messages, m.id), `leaf of ${m.id}`).toBe(leafId);
		}
	});
});

describe('findCompactionGraftFixes', () => {
	// (a) 錯接 sibling → fix
	it('detects a compaction entry grafted as sibling of the next flow message', () => {
		// Tree: root -> m1 -> [cmp1, m2] -> m3 (currNode)
		// cmp1.parent = m1, m2.parent = m1 (siblings), m3 is descendant of m2
		const root = msg('root', null, ['m1']);
		const m1 = msg('m1', 'root', ['cmp1', 'm2']);
		const cmp1 = cmpMsg('cmp1', 'm1');
		const m2 = msg('m2', 'm1', ['m3']);
		const m3 = msg('m3', 'm2');
		const fixes = findCompactionGraftFixes([root, m1, cmp1, m2, m3], 'm3');

		expect(fixes).toEqual([{ cmpId: 'cmp1', reattachId: 'm2' }]);
	});

	// (b) 正常 post-flow cmp（currNode 是 cmp descendant）→ 無
	it('does not flag a normal post-flow compaction (currNode is cmp descendant)', () => {
		// Tree: root -> m1 -> cmp1 -> m2 (currNode)
		// cmp1 is on the path, m2 is its child — no sibling issue
		const root = msg('root', null, ['m1']);
		const m1 = msg('m1', 'root', ['cmp1']);
		const cmp1 = cmpMsg('cmp1', 'm1');
		cmp1.children = ['m2'];
		const m2 = msg('m2', 'cmp1');
		const fixes = findCompactionGraftFixes([root, m1, cmp1, m2], 'm2');

		expect(fixes).toEqual([]);
	});

	// (c) 無 cmp → 無
	it('returns empty when there are no compaction entries', () => {
		const root = msg('root', null, ['m1']);
		const m1 = msg('m1', 'root', ['m2']);
		const m2 = msg('m2', 'm1');
		const fixes = findCompactionGraftFixes([root, m1, m2], 'm2');

		expect(fixes).toEqual([]);
	});

	// (d) cmp 在其它分支 → 無
	it('does not flag a compaction entry on a non-active branch', () => {
		// Tree: root -> m1 -> [m2, m4]; m2 -> m3 (currNode); m4 -> cmp1
		// cmp1 is on a different branch, not a sibling of any node on the path
		const root = msg('root', null, ['m1']);
		const m1 = msg('m1', 'root', ['m2', 'm4']);
		const m2 = msg('m2', 'm1', ['m3']);
		const m3 = msg('m3', 'm2');
		const m4 = msg('m4', 'm1', ['cmp1']);
		const cmp1 = cmpMsg('cmp1', 'm4');
		const fixes = findCompactionGraftFixes([root, m1, m2, m3, m4, cmp1], 'm3');

		expect(fixes).toEqual([]);
	});

	// (e) 兩筆錯接 cmp → 兩筆 fix
	it('detects two compaction entries grafted as siblings', () => {
		// Tree: root -> m1 -> [cmp1, m2] -> m3 -> [cmp2, m4] -> m5 (currNode)
		const root = msg('root', null, ['m1']);
		const m1 = msg('m1', 'root', ['cmp1', 'm2']);
		const cmp1 = cmpMsg('cmp1', 'm1');
		const m2 = msg('m2', 'm1', ['m3']);
		const m3 = msg('m3', 'm2', ['cmp2', 'm4']);
		const cmp2 = cmpMsg('cmp2', 'm3');
		const m4 = msg('m4', 'm3', ['m5']);
		const m5 = msg('m5', 'm4');
		const fixes = findCompactionGraftFixes([root, m1, cmp1, m2, m3, cmp2, m4, m5], 'm5');

		expect(fixes).toEqual([
			{ cmpId: 'cmp1', reattachId: 'm2' },
			{ cmpId: 'cmp2', reattachId: 'm4' }
		]);
	});
});
