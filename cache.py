class Node:

	def __init__(self, val):
		self.val = val
		self.prev = None
		self.next = None


	def addNext(n):
		self.next = n
		n.prev = self




class Cache:

	def __init__(self, size):
		self.items = {}
		self.size = size
		self.head = None
		self.tail = None

	def put(self, key, value):

		newNode = Node(key)

		#if cache is empty or full and size 1:
		if len(self.items) == 0:
			self.items[key] = value
			self.head = newNode
			self.tail = newNode
			return

		# if cache is full
		elif len(self.items) == self.size:

			if self.size == 1: 
				self.items[key] = value
				del(self.items[head.val])
				self.head = newNode
				self.tail = newNode
				return

			# remove head node
			del(self.items[self.head.val])

			self.head = self.head.next

		self.tail.next = newNode
		newNode.prev = self.tail
		self.tail = newNode

		self.items[key] = value


	def get(self, key):

		if key not in self.items:
			raise ValueError('A very specific bad thing happened.')
			return
		
		
		it = self.head
		if it.val == key:
			if it.next is None:
				self.head = None
				self.tail = None
			else:
				self.head = self.head.next
		else:
			while it.val is not key:
				it = it.next
			if it == self.tail:
				self.tail = self.tail.prev
			it.prev.next = it.next

		return(self.items.pop(key))

	def prt(self):
		it = self.head
		while it is not None:
			print(it.val)
			it = it.next
		print(self.items)
		


myCache = Cache(3)
myCache.put(7, 1)
myCache.prt()
myCache.get(7)
myCache.prt()
myCache.put(2, 1)
myCache.put(4, 2)
myCache.put(8, 3)
myCache.prt()
myCache.put(3, 1)
myCache.prt()
myCache.get(3)
myCache.prt()
myCache.put(5, 1)
myCache.prt()
myCache.put(9, 0)
myCache.prt()
myCache.put(10, 5)
myCache.prt()
myCache.put(23, 7)
myCache.prt()
