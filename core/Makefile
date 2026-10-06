# crsf-core build. `make` builds the tools and daemon, `make test` runs the unit tests.
CC      ?= gcc
CFLAGS  ?= -O2 -g
CFLAGS  += -std=gnu11 -Wall -Wextra -Werror -Wshadow -Wstrict-prototypes -Isrc
LDLIBS  += -pthread
# AddressSanitizer does not work with this Raspberry Pi kernel's address space; UBSan does.
SAN     := -fsanitize=undefined -fno-sanitize-recover=undefined

BUILD   := build
LIB_SRC := $(filter-out src/main.c,$(wildcard src/*.c))
LIB_OBJ := $(LIB_SRC:src/%.c=$(BUILD)/obj/%.o)
SAN_OBJ := $(LIB_SRC:src/%.c=$(BUILD)/san/%.o)
HDRS    := $(wildcard src/*.h) $(wildcard tests/*.h)
TOOLS   := $(patsubst tools/%.c,$(BUILD)/%,$(wildcard tools/*.c))
DAEMON  := $(if $(wildcard src/main.c),$(BUILD)/crsf-core)
TESTS   := $(patsubst tests/%.c,$(BUILD)/tests/%,$(wildcard tests/test_*.c))
PREFIX  ?= /usr/local

.PHONY: all test install clean
all: $(TOOLS) $(DAEMON)

$(BUILD)/obj/%.o: src/%.c $(HDRS)
	@mkdir -p $(dir $@)
	$(CC) $(CFLAGS) -c $< -o $@

$(BUILD)/san/%.o: src/%.c $(HDRS)
	@mkdir -p $(dir $@)
	$(CC) $(CFLAGS) $(SAN) -c $< -o $@

$(BUILD)/crsf-core: src/main.c $(LIB_OBJ)
	$(CC) $(CFLAGS) $^ -o $@ $(LDLIBS)

$(BUILD)/tests/%: tests/%.c $(SAN_OBJ)
	@mkdir -p $(dir $@)
	$(CC) $(CFLAGS) $(SAN) -Itests $^ -o $@ $(LDLIBS)

$(BUILD)/%: tools/%.c $(LIB_OBJ)
	$(CC) $(CFLAGS) $^ -o $@ $(LDLIBS)

test: $(TESTS)
	@for t in $(TESTS); do echo "== $$t"; ./$$t || exit 1; done
	@echo "ALL TESTS PASSED"

install: all
	install -d $(DESTDIR)$(PREFIX)/bin
	install -m 0755 $(TOOLS) $(DAEMON) $(DESTDIR)$(PREFIX)/bin/

clean:
	rm -rf $(BUILD)

.PHONY: integration
integration: all
	python3 -m unittest discover -s tests/integration -t tests/integration -v
